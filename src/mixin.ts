import type { VueConstructor } from 'vue'
import { ComponentInstance, SetupFunction, Data } from './component'
import { isRef, isReactive, toRefs, isRaw } from './reactivity'
import {
  isPlainObject,
  assert,
  proxy,
  warn,
  isFunction,
  isObject,
  def,
  isArray,
} from './utils'
import { ref } from './apis'
import vmStateManager from './utils/vmStateManager'
import {
  afterRender,
  activateCurrentInstance,
  resolveScopedSlots,
  asVmProperty,
  updateVmAttrs,
} from './utils/instance'
import {
  getVueConstructor,
  SetupContext,
  toVue3ComponentInstance,
} from './runtimeContext'
import { createObserver } from './reactivity/reactive'

export function mixin(Vue: VueConstructor) {
  Vue.mixin({
    beforeCreate: functionApiInit,
    mounted(this: ComponentInstance) {
      afterRender(this)
    },
    beforeUpdate() {
      updateVmAttrs(this as ComponentInstance)
    },
    updated(this: ComponentInstance) {
      afterRender(this)
    },
  })

  /**
   * Vuex init hook, injected into each instances init hooks list.
   */

  function functionApiInit(this: ComponentInstance) {
    const vm = this
    const $options = vm.$options

    // 保存原有option上的setup、render方法
    const { setup, render } = $options

    // 如果render函数存在，就不用管setup函数了
    if (render) {
      // keep currentInstance accessible for createElement
      $options.render = function (...args: any): any {
        return activateCurrentInstance(toVue3ComponentInstance(vm), () =>
          render.apply(this, args)
        )
      }
    }

    if (!setup) {
      return
    }
    if (!isFunction(setup)) {
      if (__DEV__) {
        warn(
          'The "setup" option should be a function that returns a object in component definitions.',
          vm
        )
      }
      return
    }

    // 保存原有option上的data方法
    const { data } = $options
    // wrapper the data option, so we can invoke setup before data get resolved
    // 相当于把setup包装成data函数
    $options.data = function wrappedData() {
      // 初始化setup函数中返回的data
      initSetup(vm, vm.$props)
      // 初始化data选项中的data
      return isFunction(data)
        ? (
            data as (this: ComponentInstance, x: ComponentInstance) => object
          ).call(vm, vm)
        : data || {}
    }
  }

  function initSetup(vm: ComponentInstance, props: Record<any, any> = {}) {
    const setup = vm.$options.setup! // setup函数必然存在
    const ctx = createSetupContext(vm)
    const instance = toVue3ComponentInstance(vm)
    instance.setupContext = ctx

    // 给props设置响应式？？？
    // fake reactive for `toRefs(props)`
    def(props, '__ob__', createObserver())

    // resolve scopedSlots and slots to functions
    resolveScopedSlots(vm, ctx.slots)

    // binding 即 setup 的返回值
    let binding: ReturnType<SetupFunction<Data, Data>> | undefined | null
    activateCurrentInstance(instance, () => {
      // make props to be fake reactive, this is for `toRefs(props)`
      // 执行我们传入的setup函数的地方，binding是setup的返回值
      binding = setup(props, ctx)
    })

    if (!binding) return
    // 如果返回值是一个函数的话，看起来应该是个渲染函数
    if (isFunction(binding)) {
      // keep typescript happy with the binding type.
      const bindingFunc = binding
      // keep currentInstance accessible for createElement
      vm.$options.render = () => {
        resolveScopedSlots(vm, ctx.slots)
        return activateCurrentInstance(instance, () => bindingFunc())
      }
      return
    }
    // 如果返回的是一个纯对象
    else if (isObject(binding)) {
      if (isReactive(binding)) {
        binding = toRefs(binding) as Data // 需要把这个对象进行响应式处理
      }

      // 这里对vm进行了一点修改，为vm加了__composition_api_state__属性
      vmStateManager.set(vm, 'rawBindings', binding)
      const bindingObj = binding

      // 统一bindingValue的格式并赋值
      // 已经是ref或响应式对象的值不做处理；
      // 基本类型的值与数组转为ref
      // TODO: 好像没考虑对象？
      Object.keys(bindingObj).forEach((name) => {
        let bindingValue: any = bindingObj[name]

        // 如果遍历访问到的值不是一个ref
        if (!isRef(bindingValue)) {
          // 如果遍历访问到的值也不是一个响应式对象
          if (!isReactive(bindingValue)) {
            // 如果这个值为函数
            if (isFunction(bindingValue)) {
              const copy = bindingValue
              bindingValue = bindingValue.bind(vm)
              Object.keys(copy).forEach(function (ele) {
                bindingValue[ele] = copy[ele]
              })
            }
            // 如果这个值不是对象的话，需要用ref包一下
            else if (!isObject(bindingValue)) {
              bindingValue = ref(bindingValue)
            } else if (hasReactiveArrayChild(bindingValue)) {
              // creates a custom reactive properties without make the object explicitly reactive
              // NOTE we should try to avoid this, better implementation needed
              customReactive(bindingValue)
            }
          }
          // 如果这个值是一个数组的话，也需要用ref包一下
          else if (isArray(bindingValue)) {
            bindingValue = ref(bindingValue)
          }
        }
        // 把bindingValue作为属性放到vm上，这样模板里也可以访问到setup中的属性
        asVmProperty(vm, name, bindingValue)
      })

      return
    }

    if (__DEV__) {
      assert(
        false,
        `"setup" must return a "Object" or a "Function", got "${Object.prototype.toString
          .call(binding)
          .slice(8, -1)}"`
      )
    }
  }

  function customReactive(target: object, seen = new Set()) {
    if (seen.has(target)) return
    if (
      !isPlainObject(target) ||
      isRef(target) ||
      isReactive(target) ||
      isRaw(target)
    )
      return
    const Vue = getVueConstructor()
    // @ts-expect-error https://github.com/vuejs/vue/pull/12132
    const defineReactive = Vue.util.defineReactive

    Object.keys(target).forEach((k) => {
      const val = target[k]
      defineReactive(target, k, val)
      if (val) {
        seen.add(val)
        customReactive(val, seen)
      }
      return
    })
  }

  function hasReactiveArrayChild(target: object, visited = new Map()): boolean {
    if (visited.has(target)) {
      return visited.get(target)
    }
    visited.set(target, false)
    if (isArray(target) && isReactive(target)) {
      visited.set(target, true)
      return true
    }

    if (!isPlainObject(target) || isRaw(target) || isRef(target)) {
      return false
    }
    return Object.keys(target).some((x) =>
      hasReactiveArrayChild(target[x], visited)
    )
  }

  function createSetupContext(
    vm: ComponentInstance & { [x: string]: any }
  ): SetupContext {
    const ctx = { slots: {} } as SetupContext

    const propsPlain = [
      'root',
      'parent',
      'refs',
      'listeners',
      'isServer',
      'ssrContext',
    ]
    const methodReturnVoid = ['emit']

    propsPlain.forEach((key) => {
      let srcKey = `$${key}`
      proxy(ctx, key, {
        get: () => vm[srcKey],
        set() {
          __DEV__ &&
            warn(
              `Cannot assign to '${key}' because it is a read-only property`,
              vm
            )
        },
      })
    })

    updateVmAttrs(vm, ctx)

    methodReturnVoid.forEach((key) => {
      const srcKey = `$${key}`
      proxy(ctx, key, {
        get() {
          return (...args: any[]) => {
            const fn: Function = vm[srcKey]
            fn.apply(vm, args)
          }
        },
      })
    })
    if (process.env.NODE_ENV === 'test') {
      ;(ctx as any)._vm = vm
    }
    return ctx
  }
}
