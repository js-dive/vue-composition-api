import {
  ComponentInternalInstance,
  getCurrentInstance,
  getVueConstructor,
  withCurrentInstanceTrackingDisabled,
} from '../runtimeContext'
import { defineComponentInstance } from '../utils'
import { warn } from './warn'

/**
 * 正在活动（全局唯一）的effectScope
 */
let activeEffectScope: EffectScope | undefined
const effectScopeStack: EffectScope[] = []

class EffectScopeImpl {
  active = true
  effects: EffectScope[] = []
  cleanups: (() => void)[] = []

  /**
   * @internal
   **/
  vm: Vue

  constructor(vm: Vue) {
    this.vm = vm
  }

  run<T>(fn: () => T): T | undefined {
    if (this.active) {
      try {
        this.on()
        return fn()
      } finally {
        this.off()
      }
    } else if (__DEV__) {
      warn(`cannot run an inactive effect scope.`)
    }
    return
  }

  on() {
    if (this.active) {
      effectScopeStack.push(this)
      activeEffectScope = this
    }
  }

  off() {
    if (this.active) {
      effectScopeStack.pop()
      activeEffectScope = effectScopeStack[effectScopeStack.length - 1]
    }
  }

  stop() {
    if (this.active) {
      this.vm.$destroy()
      this.effects.forEach((e) => e.stop())
      this.cleanups.forEach((cleanup) => cleanup())
      this.active = false
    }
  }
}

export class EffectScope extends EffectScopeImpl {
  constructor(detached = false) {
    let vm: Vue = undefined!
    withCurrentInstanceTrackingDisabled(() => {
      vm = defineComponentInstance(getVueConstructor())
    })
    super(vm)
    if (!detached) {
      recordEffectScope(this)
    }
  }
}

/**
 * 记录effectScope？
 * @param effect
 * @param scope
 * @returns
 */
export function recordEffectScope(
  effect: EffectScope,
  scope?: EffectScope | null
) {
  scope = scope || activeEffectScope
  if (scope && scope.active) {
    // 如果不是游离的Effect，那么就往当前scope effects里push一下传入的effect
    // 看起来有点像一棵树
    scope.effects.push(effect)
    return
  }
  // destory on parent component unmounted
  const vm = getCurrentInstance()?.proxy
  vm && vm.$on('hook:destroyed', () => effect.stop())
}

export function effectScope(detached?: boolean) {
  return new EffectScope(detached)
}

export function getCurrentScope() {
  return activeEffectScope
}

export function onScopeDispose(fn: () => void) {
  if (activeEffectScope) {
    activeEffectScope.cleanups.push(fn)
  } else if (__DEV__) {
    warn(
      `onScopeDispose() is called when there is no active effect scope` +
        ` to be associated with.`
    )
  }
}

/**
 * 获得当前在scope内的vm？TODO: 为何有两种写法？
 * @internal
 **/
export function getCurrentScopeVM() {
  return getCurrentScope()?.vm || getCurrentInstance()?.proxy
}

/**
 * 绑定当前scope到vm上？
 * @internal
 **/
export function bindCurrentScopeToVM(
  vm: ComponentInternalInstance
): EffectScope {
  // 如果vm上没有scope，就设置一下
  if (!vm.scope) {
    const scope = new EffectScopeImpl(vm.proxy) as EffectScope
    vm.scope = scope

    // vm销毁的时候，scope给停掉
    vm.proxy.$on('hook:destroyed', () => scope.stop())
  }
  return vm.scope
}
