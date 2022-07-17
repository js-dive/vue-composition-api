import { getVueConstructor } from '../runtimeContext'
import { createRef, ComputedRef, WritableComputedRef } from '../reactivity'
import {
  warn,
  noopFn,
  defineComponentInstance,
  getVueInternalClasses,
  isFunction,
} from '../utils'
import { getCurrentScopeVM } from './effectScope'

export type ComputedGetter<T> = (ctx?: any) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

// read-only
export function computed<T>(getter: ComputedGetter<T>): ComputedRef<T>
// writable
export function computed<T>(
  options: WritableComputedOptions<T>
): WritableComputedRef<T>
// implement
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>
): ComputedRef<T> | WritableComputedRef<T> {
  // 获得当前激活的（在作用域内的vm）
  const vm = getCurrentScopeVM()
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T> | undefined

  // 归一化getterOrOptions，将它们分别赋值给getter、setter
  if (isFunction(getterOrOptions)) {
    getter = getterOrOptions
  } else {
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  let computedSetter
  let computedGetter

  // 如果能拿到vm，并且在非服务器渲染环境下
  if (vm && !vm.$isServer) {
    // 获得Vue内部的Watcher及Dep类
    const { Watcher, Dep } = getVueInternalClasses()
    let watcher: any
    computedGetter = () => {
      if (!watcher) {
        // 设置计算属性Watcher —— 逻辑与传统的Vue 2主项目一致
        watcher = new Watcher(vm, getter, noopFn, { lazy: true })
      }
      // 如果watcher dirty了，就重新进行一次计算来获取新的值
      if (watcher.dirty) {
        watcher.evaluate()
      }
      // TODO: 如果存在全剧唯一正在被计算的watcher，那么就进行以来收集
      if (Dep.target) {
        watcher.depend()
      }
      // 返回计算属性watcher的值
      return watcher.value
    }

    computedSetter = (v: T) => {
      if (__DEV__ && !setter) {
        warn('Write operation failed: computed value is readonly.', vm!)
        return
      }

      if (setter) {
        setter(v)
      }
    }
  }
  // 否则，创建一个新的vue实例，来托管computed
  else {
    // fallback
    const computedHost = defineComponentInstance(getVueConstructor(), {
      computed: {
        $$state: {
          get: getter,
          set: setter,
        },
      },
    })

    vm && vm.$on('hook:destroyed', () => computedHost.$destroy())

    computedGetter = () => (computedHost as any).$$state
    computedSetter = (v: T) => {
      if (__DEV__ && !setter) {
        warn('Write operation failed: computed value is readonly.', vm!)
        return
      }

      ;(computedHost as any).$$state = v
    }
  }

  // 返回一个用于获得computed值的ref
  return createRef<T>(
    {
      get: computedGetter,
      set: computedSetter,
    },
    !setter,
    true
  ) as WritableComputedRef<T> | ComputedRef<T>
}
