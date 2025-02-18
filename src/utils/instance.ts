import type { VNode } from 'vue'
import { ComponentInstance } from '../component'
import vmStateManager from './vmStateManager'
import {
  setCurrentInstance,
  getCurrentInstance,
  ComponentInternalInstance,
  InternalSlots,
  SetupContext,
} from '../runtimeContext'
import { Ref, isRef, isReactive } from '../apis'
import { hasOwn, proxy, warn } from './utils'
import { createSlotProxy, resolveSlots } from './helper'
import { reactive } from '../reactivity/reactive'

/**
 * 在vm上赋值属性
 * 例如：将setup返回值上的属性代理到vm上；内部用defineProperty get、set 实现
 */
export function asVmProperty(
  vm: ComponentInstance,
  propName: string,
  propValue: Ref<unknown>
) {
  const props = vm.$options.props
  // 如果vm中不存在名为`propName`的属性，且vm的props选项中也没有名为`propName`
  if (!(propName in vm) && !(props && hasOwn(props, propName))) {
    // 如果值被ref包过
    if (isRef(propValue)) {
      proxy(vm, propName, {
        get: () => propValue.value,
        set: (val: unknown) => {
          propValue.value = val
        },
      })
    }
    // 如果值没有被ref包过（可能是响应式对象？）
    else {
      proxy(vm, propName, {
        get: () => {
          if (isReactive(propValue)) {
            // 进行一次依赖收集，使得watcher依赖这个值？
            ;(propValue as any).__ob__.dep.depend()
          }
          return propValue
        },
        set: (val: any) => {
          propValue = val
        },
      })
    }

    if (__DEV__) {
      // 开发环境下会把setup函数返回的值往_data上存一份，因此开发者工具中可以看到相关属性
      // expose binding to Vue Devtool as a data property
      // delay this until state has been resolved to prevent repeated works
      vm.$nextTick(() => {
        if (Object.keys(vm._data).indexOf(propName) !== -1) {
          return
        }
        if (isRef(propValue)) {
          proxy(vm._data, propName, {
            get: () => propValue.value,
            set: (val: unknown) => {
              propValue.value = val
            },
          })
        } else {
          proxy(vm._data, propName, {
            get: () => propValue,
            set: (val: any) => {
              propValue = val
            },
          })
        }
      })
    }
  }
  // 如果来到这里，说明`propName`与vm的props重名了
  else if (__DEV__) {
    if (props && hasOwn(props, propName)) {
      warn(
        `The setup binding property "${propName}" is already declared as a prop.`,
        vm
      )
    } else {
      warn(`The setup binding property "${propName}" is already declared.`, vm)
    }
  }
}

/**
 * 来更新 setupState （aka. rawBindings）中对元素/组件的引用（ref="xxx"）到最新的渲染结果
 * @param vm
 * @returns
 */
function updateTemplateRef(vm: ComponentInstance) {
  const rawBindings = vmStateManager.get(vm, 'rawBindings') || {}
  if (!rawBindings || !Object.keys(rawBindings).length) return

  const refs = vm.$refs
  const oldRefKeys = vmStateManager.get(vm, 'refs') || []
  for (let index = 0; index < oldRefKeys.length; index++) {
    const key = oldRefKeys[index]
    const setupValue = rawBindings[key]
    if (!refs[key] && setupValue && isRef(setupValue)) {
      setupValue.value = null
    }
  }

  const newKeys = Object.keys(refs)
  const validNewKeys = []
  for (let index = 0; index < newKeys.length; index++) {
    const key = newKeys[index]
    const setupValue = rawBindings[key]
    if (refs[key] && setupValue && isRef(setupValue)) {
      setupValue.value = refs[key]
      validNewKeys.push(key)
    }
  }
  vmStateManager.set(vm, 'refs', validNewKeys)
}

/**
 * 全局混入的mounted函数
 * 内部调用 updateTemplateRef 来更新 setupState （aka. rawBindings）中对元素/组件的引用（ref="xxx"）到最新的渲染结果
 * @param vm 要操作的vm
 */
export function afterRender(vm: ComponentInstance) {
  const stack = [(vm as any)._vnode as VNode]
  while (stack.length) {
    const vnode = stack.pop()!
    if (vnode.context) updateTemplateRef(vnode.context)
    if (vnode.children) {
      for (let i = 0; i < vnode.children.length; ++i) {
        stack.push(vnode.children[i])
      }
    }
  }
}

export function updateVmAttrs(vm: ComponentInstance, ctx?: SetupContext) {
  if (!vm) {
    return
  }
  let attrBindings = vmStateManager.get(vm, 'attrBindings')
  if (!attrBindings && !ctx) {
    // fix 840
    return
  }
  if (!attrBindings) {
    const observedData = reactive({})
    attrBindings = { ctx: ctx!, data: observedData }
    vmStateManager.set(vm, 'attrBindings', attrBindings)
    proxy(ctx, 'attrs', {
      get: () => {
        return attrBindings?.data
      },
      set() {
        __DEV__ &&
          warn(
            `Cannot assign to '$attrs' because it is a read-only property`,
            vm
          )
      },
    })
  }

  const source = vm.$attrs
  for (const attr of Object.keys(source)) {
    if (!hasOwn(attrBindings.data, attr)) {
      proxy(attrBindings.data, attr, {
        get: () => {
          // to ensure it always return the latest value
          return vm.$attrs[attr]
        },
      })
    }
  }
}

export function resolveScopedSlots(
  vm: ComponentInstance,
  slotsProxy: InternalSlots
): void {
  const parentVNode = (vm.$options as any)._parentVnode
  if (!parentVNode) return

  const prevSlots = vmStateManager.get(vm, 'slots') || []
  const curSlots = resolveSlots(parentVNode.data.scopedSlots, vm.$slots)
  // remove staled slots
  for (let index = 0; index < prevSlots.length; index++) {
    const key = prevSlots[index]
    if (!curSlots[key]) {
      delete slotsProxy[key]
    }
  }

  // proxy fresh slots
  const slotNames = Object.keys(curSlots)
  for (let index = 0; index < slotNames.length; index++) {
    const key = slotNames[index]
    if (!slotsProxy[key]) {
      slotsProxy[key] = createSlotProxy(vm, key)
    }
  }
  vmStateManager.set(vm, 'slots', slotNames)
}

// 激活当前实例
export function activateCurrentInstance(
  instance: ComponentInternalInstance,
  fn: (instance: ComponentInternalInstance) => any,
  onError?: (err: Error) => void
) {
  // 先保存上一个实例
  let preVm = getCurrentInstance()
  // 设置当前实例
  setCurrentInstance(instance)
  try {
    // 执行回调setup函数的地方
    return fn(instance)
  } catch (
    // FIXME: remove any
    err: any
  ) {
    if (onError) {
      onError(err)
    } else {
      throw err
    }
  } finally {
    // 恢复上一个实例
    setCurrentInstance(preVm)
  }
}
