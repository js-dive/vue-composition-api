import { VueConstructor } from 'vue'
import {
  getVueConstructor,
  setCurrentInstance,
  getCurrentInstance,
  ComponentInternalInstance,
} from '../runtimeContext'
import { getCurrentInstanceForFn } from '../utils/helper'

const genName = (name: string) => `on${name[0].toUpperCase() + name.slice(1)}`

/**
 * 生命周期工厂函数？
 * @param lifeCyclehook 生命周期的名称
 * @returns
 */
function createLifeCycle(lifeCyclehook: string) {
  return (
    /**
     * 在setup函数执行期间，在调用生命周期钩子（如onMounted等）将会执行的函数 - 该函数用于合并生命周期钩子
     * @param callback 生命周期回调函数
     * @param target Vue3 对象
     * @returns
     */
    (callback: Function, target?: ComponentInternalInstance | null) => {
      const instance = getCurrentInstanceForFn(genName(lifeCyclehook), target)
      return (
        instance &&
        injectHookOption(getVueConstructor(), instance, lifeCyclehook, callback)
      )
    }
  )
}

/**
 * 合并生命周期钩子
 * @param Vue Vue构造函数
 * @param instance 当前实例（Vue3）
 * @param hook 生命周期钩子名称
 * @param val 值（生命周期回调函数）
 * @returns
 */
function injectHookOption(
  Vue: VueConstructor,
  instance: ComponentInternalInstance,
  hook: string,
  val: Function
) {
  // 当前实例中的选项
  const options = instance.proxy.$options as Record<string, unknown>
  // 获得钩子的合并策略 - 见Vue2源代码 `mergeHook`
  const mergeFn = Vue.config.optionMergeStrategies[hook]
  // 获得一个经过包裹的回调函数
  const wrappedHook = wrapHookCall(instance, val)
  // 将经过合并的钩子重新赋值给到组件option
  // options[hook] 是个数组，组件生命周期的执行实际上是挨个执行其中的函数
  // 每调用一次对应的onHook（eg. onMounted）都会往对应数组里加一个函数
  options[hook] = mergeFn(options[hook], wrappedHook)
  return wrappedHook
}

/**
 * 获得一个经过包裹的回调函数 - 经过包裹后，回调函数执行期间，将确保正在激活的组件实例是当前实例（Vue3）
 * @param instance 当前实例（Vue3）
 * @param fn 生命周期钩子中的回调函数
 * @returns 经过包裹后的回调函数
 */
function wrapHookCall(
  instance: ComponentInternalInstance,
  fn: Function
): Function {
  return (...args: any) => {
    // 保存上一个正在激活状态的组件（Vue3）
    let prev = getCurrentInstance()
    // 设置激活状态组件为当前组件（Vue3）
    setCurrentInstance(instance)
    try {
      // 执行生命周期钩子的回调函数
      return fn(...args)
    } finally {
      // 恢复上一个正在激活状态的组件（Vue3）
      setCurrentInstance(prev)
    }
  }
}

export const onBeforeMount = createLifeCycle('beforeMount')
export const onMounted = createLifeCycle('mounted')
export const onBeforeUpdate = createLifeCycle('beforeUpdate')
export const onUpdated = createLifeCycle('updated')
export const onBeforeUnmount = createLifeCycle('beforeDestroy')
export const onUnmounted = createLifeCycle('destroyed')
export const onErrorCaptured = createLifeCycle('errorCaptured')
export const onActivated = createLifeCycle('activated')
export const onDeactivated = createLifeCycle('deactivated')
export const onServerPrefetch = createLifeCycle('serverPrefetch')
