import type { VueConstructor } from 'vue'
import { AnyObject } from './types/basic'
import { isFunction, hasSymbol, hasOwn, isPlainObject, warn } from './utils'
import { isRef } from './reactivity'
import { setVueConstructor, isVueRegistered } from './runtimeContext'
import { mixin } from './mixin'

/**
 * Helper that recursively merges two data objects together.
 * 递归地合并两个data对象？
 */
function mergeData(from: AnyObject, to: AnyObject): Object {
  if (!from) return to
  if (!to) return from

  let key: any
  let toVal: any
  let fromVal: any

  const keys = hasSymbol ? Reflect.ownKeys(from) : Object.keys(from)

  for (let i = 0; i < keys.length; i++) {
    key = keys[i]
    // in case the object is already observed...
    if (key === '__ob__') continue
    toVal = to[key]
    fromVal = from[key]
    if (!hasOwn(to, key)) {
      to[key] = fromVal
    } else if (
      toVal !== fromVal &&
      isPlainObject(toVal) &&
      !isRef(toVal) &&
      isPlainObject(fromVal) &&
      !isRef(fromVal)
    ) {
      mergeData(fromVal, toVal)
    }
  }
  return to
}

export function install(Vue: VueConstructor) {
  // 防止被插件被多次安装
  if (isVueRegistered(Vue)) {
    if (__DEV__) {
      warn(
        '[vue-composition-api] already installed. Vue.use(VueCompositionAPI) should be called only once.'
      )
    }
    return
  }

  if (__DEV__) {
    if (Vue.version) {
      if (Vue.version[0] !== '2' || Vue.version[1] !== '.') {
        warn(
          `[vue-composition-api] only works with Vue 2, v${Vue.version} found.`
        )
      }
    } else {
      warn('[vue-composition-api] no Vue version found')
    }
  }

  // 配置setup的合并策略
  Vue.config.optionMergeStrategies.setup = function (
    parent: Function,
    child: Function
  ) {
    return function mergedSetupFn(props: any, context: any) {
      return mergeData(
        isFunction(parent) ? parent(props, context) || {} : undefined,
        isFunction(child) ? child(props, context) || {} : undefined
      )
    }
  }

  // 在Vue类上记录一个表示插件已安装的标志位
  setVueConstructor(Vue)
  // 配置全局mixin
  mixin(Vue)
}

export const Plugin = {
  install: (Vue: VueConstructor) => install(Vue),
}
