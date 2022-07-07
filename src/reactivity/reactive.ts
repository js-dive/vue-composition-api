import { AnyObject } from '../types/basic'
import { getRegisteredVueOrDefault } from '../runtimeContext'
import {
  isPlainObject,
  def,
  warn,
  isArray,
  hasOwn,
  noopFn,
  isObject,
  proxy,
} from '../utils'
import { isComponentInstance, defineComponentInstance } from '../utils/helper'
import { RefKey } from '../utils/symbols'
import { isRef, UnwrapRef } from './ref'
import { rawSet, accessModifiedSet } from '../utils/sets'
import { isForceTrigger } from './force'

export function isRaw(obj: any): boolean {
  return Boolean(
    obj &&
      hasOwn(obj, '__ob__') &&
      typeof obj.__ob__ === 'object' &&
      obj.__ob__?.__raw__
  )
}

export function isReactive(obj: any): boolean {
  return Boolean(
    obj &&
      hasOwn(obj, '__ob__') &&
      typeof obj.__ob__ === 'object' &&
      !obj.__ob__?.__raw__
  )
}

/**
 * Proxing property access of target.
 * We can do unwrapping and other things here.
 */
function setupAccessControl(target: AnyObject): void {
  if (
    !isPlainObject(target) ||
    isRaw(target) ||
    isArray(target) ||
    isRef(target) ||
    isComponentInstance(target) ||
    accessModifiedSet.has(target)
  )
    return

  accessModifiedSet.set(target, true)

  const keys = Object.keys(target)
  for (let i = 0; i < keys.length; i++) {
    defineAccessControl(target, keys[i])
  }
}

/**
 * Auto unwrapping when access property
 */
export function defineAccessControl(target: AnyObject, key: any, val?: any) {
  if (key === '__ob__') return
  if (isRaw(target[key])) return

  let getter: (() => any) | undefined
  let setter: ((x: any) => void) | undefined
  const property = Object.getOwnPropertyDescriptor(target, key)
  if (property) {
    if (property.configurable === false) {
      return
    }
    getter = property.get
    setter = property.set
    if (
      (!getter || setter) /* not only have getter */ &&
      arguments.length === 2
    ) {
      val = target[key]
    }
  }

  setupAccessControl(val)
  proxy(target, key, {
    get: function getterHandler() {
      const value = getter ? getter.call(target) : val
      // if the key is equal to RefKey, skip the unwrap logic
      if (key !== RefKey && isRef(value)) {
        return value.value
      } else {
        return value
      }
    },
    set: function setterHandler(newVal: any) {
      if (getter && !setter) return

      // If the key is equal to RefKey, skip the unwrap logic
      // If and only if "value" is ref and "newVal" is not a ref,
      // the assignment should be proxied to "value" ref.
      if (key !== RefKey && isRef(val) && !isRef(newVal)) {
        val.value = newVal
      } else if (setter) {
        setter.call(target, newVal)
        val = newVal
      } else {
        val = newVal
      }
      setupAccessControl(newVal)
    },
  })
}

/**
 * 返回一个经过响应式处理的对象
 * 该函数被shallowReactive、reactive、shallowReadonly所使用
 * @param obj 对象
 * @returns
 */
export function observe<T>(obj: T): T {
  const Vue = getRegisteredVueOrDefault()
  let observed: T
  // 低版本Vue中不存在observable这个方法，在这里做了兼容
  if (Vue.observable) {
    // 显式调用vue中用于监听对象的observe函数
    observed = Vue.observable(obj)
  } else {
    // 兼容处理看起来是生成了一个新的vue实例
    const vm = defineComponentInstance(Vue, {
      data: {
        $$state: obj,
      },
    })
    observed = vm._data.$$state
  }

  // in SSR, there is no __ob__. Mock for reactivity check
  if (!hasOwn(observed, '__ob__')) {
    mockReactivityDeep(observed)
  }

  return observed
}

/**
 * Mock __ob__ for object recursively
 */
export function mockReactivityDeep(obj: any, seen = new Set()) {
  if (seen.has(obj) || hasOwn(obj, '__ob__') || !Object.isExtensible(obj))
    return

  def(obj, '__ob__', mockObserver(obj))
  seen.add(obj)

  for (const key of Object.keys(obj)) {
    const value = obj[key]
    if (
      !(isPlainObject(value) || isArray(value)) ||
      isRaw(value) ||
      !Object.isExtensible(value)
    ) {
      continue
    }
    mockReactivityDeep(value, seen)
  }
}

function mockObserver(value: any = {}): any {
  return {
    value,
    dep: {
      notify: noopFn,
      depend: noopFn,
      addSub: noopFn,
      removeSub: noopFn,
    },
  }
}

// 仅仅是用于获得__ob__对象
export function createObserver() {
  return observe<any>({}).__ob__
}

/**
 * 创建一个响应式代理，它跟踪其自身 property 的响应性，但不执行嵌套对象的深层响应式转换 (暴露原始值)
 * @param obj
 */
export function shallowReactive<T extends object = any>(obj: T): T
export function shallowReactive(obj: any) {
  if (!isObject(obj)) {
    if (__DEV__) {
      warn('"shallowReactive()" must be called on an object.')
    }
    return obj
  }

  if (
    !(isPlainObject(obj) || isArray(obj)) ||
    isRaw(obj) ||
    !Object.isExtensible(obj)
  ) {
    return obj
  }

  const observed = observe(isArray(obj) ? [] : {})

  const ob = (observed as any).__ob__

  for (const key of Object.keys(obj)) {
    let val = obj[key]
    let getter: (() => any) | undefined
    let setter: ((x: any) => void) | undefined
    const property = Object.getOwnPropertyDescriptor(obj, key)
    if (property) {
      if (property.configurable === false) {
        continue
      }
      getter = property.get
      setter = property.set
    }

    proxy(observed, key, {
      get: function getterHandler() {
        ob.dep?.depend()
        return val
      },
      set: function setterHandler(newVal: any) {
        if (getter && !setter) return

        if (!isForceTrigger() && val === newVal) return
        if (setter) {
          setter.call(obj, newVal)
        } else {
          val = newVal
        }
        ob.dep?.notify()
      },
    })
  }
  return observed
}

/**
 * Make obj reactivity
 *
 * 返回对象的响应式副本
 */
export function reactive<T extends object>(obj: T): UnwrapRef<T> {
  if (!isObject(obj)) {
    if (__DEV__) {
      warn('"reactive()" must be called on an object.')
    }
    return obj
  }

  if (
    !(isPlainObject(obj) || isArray(obj)) ||
    isRaw(obj) ||
    !Object.isExtensible(obj)
  ) {
    return obj as any
  }

  const observed = observe(obj)
  setupAccessControl(observed)
  return observed as UnwrapRef<T>
}

/**
 * 确保对象不被响应式处理
 * Make sure obj can't be a reactive
 */
export function markRaw<T extends object>(obj: T): T {
  if (!(isPlainObject(obj) || isArray(obj)) || !Object.isExtensible(obj)) {
    return obj
  }

  // set the vue observable flag at obj
  const ob = createObserver()
  ob.__raw__ = true
  def(obj, '__ob__', ob)

  // mark as Raw
  rawSet.set(obj, true)

  return obj
}

export function toRaw<T>(observed: T): T {
  if (isRaw(observed) || !Object.isExtensible(observed)) {
    return observed
  }

  return (observed as any)?.__ob__?.value || observed
}
