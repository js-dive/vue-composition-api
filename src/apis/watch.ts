import { ComponentInstance } from '../component'
import { Ref, isRef, isReactive, ComputedRef } from '../reactivity'
import {
  assert,
  logError,
  noopFn,
  warn,
  isFunction,
  isObject,
  isArray,
  isPlainObject,
  isSet,
  isMap,
  isSame,
} from '../utils'
import { defineComponentInstance } from '../utils/helper'
import { getVueConstructor } from '../runtimeContext'
import {
  WatcherPreFlushQueueKey,
  WatcherPostFlushQueueKey,
} from '../utils/symbols'
import { getCurrentScopeVM } from './effectScope'
import { rawSet } from '../utils/sets'

export type WatchEffect = (onInvalidate: InvalidateCbRegistrator) => void

export type WatchSource<T = any> = Ref<T> | ComputedRef<T> | (() => T)

export type WatchCallback<V = any, OV = any> = (
  value: V,
  oldValue: OV,
  onInvalidate: InvalidateCbRegistrator
) => any

type MapSources<T> = {
  [K in keyof T]: T[K] extends WatchSource<infer V> ? V : never
}

type MapOldSources<T, Immediate> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? Immediate extends true
      ? V | undefined
      : V
    : never
}

export interface WatchOptionsBase {
  flush?: FlushMode
  // onTrack?: ReactiveEffectOptions['onTrack'];
  // onTrigger?: ReactiveEffectOptions['onTrigger'];
}

type InvalidateCbRegistrator = (cb: () => void) => void

export type FlushMode = 'pre' | 'post' | 'sync'

export interface WatchOptions<Immediate = boolean> extends WatchOptionsBase {
  immediate?: Immediate
  deep?: boolean
}

export interface VueWatcher {
  lazy: boolean
  get(): any
  teardown(): void
  run(): void

  value: any
}

export type WatchStopHandle = () => void

let fallbackVM: ComponentInstance

function flushPreQueue(this: any) {
  flushQueue(this, WatcherPreFlushQueueKey)
}

function flushPostQueue(this: any) {
  flushQueue(this, WatcherPostFlushQueueKey)
}

function hasWatchEnv(vm: any) {
  return vm[WatcherPreFlushQueueKey] !== undefined
}

/**
 * 初始化vm watch的环境
 * 看起来是在vm中加入WatcherPreFlushQueueKey、WatcherPostFlushQueueKey
 * 这两个值是数组
 *
 * @param vm Vue组件
 */
function installWatchEnv(vm: any) {
  vm[WatcherPreFlushQueueKey] = []
  vm[WatcherPostFlushQueueKey] = []

  // 组件更新前冲刷前置队列
  vm.$on('hook:beforeUpdate', flushPreQueue)
  // 组件更新后冲刷后置队列
  vm.$on('hook:updated', flushPostQueue)
}

/**
 * 合并watcher选项
 * @param options watcher的选项
 * @returns
 */
function getWatcherOption(options?: Partial<WatchOptions>): WatchOptions {
  return {
    ...{
      immediate: false,
      deep: false,
      flush: 'pre',
    },
    ...options,
  }
}

/**
 * 合并watch Effect的选项
 * @param options watchEffect的选项
 * @returns
 */
function getWatchEffectOption(options?: Partial<WatchOptions>): WatchOptions {
  return {
    ...{
      flush: 'pre',
    },
    ...options,
  }
}

function getWatcherVM() {
  let vm = getCurrentScopeVM()
  if (!vm) {
    if (!fallbackVM) {
      fallbackVM = defineComponentInstance(getVueConstructor())
    }
    vm = fallbackVM
  } else if (!hasWatchEnv(vm)) {
    installWatchEnv(vm)
  }
  return vm
}

/**
 * 冲刷队列
 * @param vm Vue组件
 * @param key 队列的key
 */
function flushQueue(vm: any, key: any) {
  const queue = vm[key]
  for (let index = 0; index < queue.length; index++) {
    queue[index]()
  }
  queue.length = 0
}

/**
 * 将任务排到冲刷队列中
 * @param vm
 * @param fn 回调函数
 * @param mode 清空模式
 */
function queueFlushJob(
  vm: any,
  fn: () => void,
  mode: Exclude<FlushMode, 'sync'>
) {
  // 在 beforeUpdate 与 updated 未触发前冲刷一次
  // flush all when beforeUpdate and updated are not fired
  const fallbackFlush = () => {
    vm.$nextTick(() => {
      // beforeUpdate生命周期之前冲刷
      if (vm[WatcherPreFlushQueueKey].length) {
        flushQueue(vm, WatcherPreFlushQueueKey)
      }
      // update生命周期之后冲刷
      if (vm[WatcherPostFlushQueueKey].length) {
        flushQueue(vm, WatcherPostFlushQueueKey)
      }
    })
  }

  switch (mode) {
    case 'pre':
      fallbackFlush()
      vm[WatcherPreFlushQueueKey].push(fn)
      break
    case 'post':
      fallbackFlush()
      vm[WatcherPostFlushQueueKey].push(fn)
      break
    default:
      assert(
        false,
        `flush must be one of ["post", "pre", "sync"], but got ${mode}`
      )
      break
  }
}

/**
 * 创建Watcher - 实际上是对vm.$watch的封装
 * 由createWatcher在内部进行调用
 *
 * @param vm 当前实例
 * @param getter 监听源 - 这里似乎传入的是一个函数
 * @param callback 回调函数
 * @param options 选项
 * @returns 被设置好的watcher
 */
function createVueWatcher(
  vm: ComponentInstance,
  getter: () => any,
  callback: (n: any, o: any) => any,
  options: {
    deep: boolean
    sync: boolean
    immediateInvokeCallback?: boolean
    noRun?: boolean
    before?: () => void
  }
): VueWatcher {
  const index = vm._watchers.length
  // 这里会往vm._watchers中插入新设置的watcher
  // @ts-ignore: use undocumented options
  vm.$watch(getter, callback, {
    immediate: options.immediateInvokeCallback,
    deep: options.deep,
    lazy: options.noRun,
    sync: options.sync,
    before: options.before,
  })

  return vm._watchers[index]
}

// We have to monkeypatch the teardown function so Vue will run
// runCleanup() when it tears down the watcher on unmounted.
/**
 * 将watcher中的teardown方法进行一些额外处理，使得Vue能够在卸载时运行runCleanup()
 *
 * monkeypatch 即运行时动态替换
 *
 * @param watcher Watcher
 * @param runCleanup runCleanup
 */
function patchWatcherTeardown(watcher: VueWatcher, runCleanup: () => void) {
  // 保留原有teardown方法
  const _teardown = watcher.teardown
  // 将原有teardown方法替换为如下方法
  watcher.teardown = function (...args) {
    // 首先执行原有方法
    _teardown.apply(watcher, args)
    // 然后再执行runCleanup
    runCleanup()
  }
}

/**
 * 创建watcher 由watch、watchEffect在内部进行调用
 *
 * @param vm 当前实例
 * @param source 监听源
 * @param cb 回调函数
 * @param options 选项
 * @returns 一个用于关闭watcher的函数
 */
function createWatcher(
  vm: ComponentInstance,
  source: WatchSource<unknown> | WatchSource<unknown>[] | WatchEffect,
  cb: WatchCallback<any> | null,
  options: WatchOptions
): () => void {
  // cb 未传入，但传了immediate、deep时将会报错
  if (__DEV__ && !cb) {
    if (options.immediate !== undefined) {
      warn(
        `watch() "immediate" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
    if (options.deep !== undefined) {
      warn(
        `watch() "deep" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
  }

  // 冲刷模式
  const flushMode = options.flush
  // 是否同步地进行冲刷标识
  const isSync = flushMode === 'sync'

  //#region 清理函数定义、设置
  let cleanup: (() => void) | null
  const registerCleanup: InvalidateCbRegistrator = (fn: () => void) => {
    cleanup = () => {
      try {
        fn()
      } catch (
        // FIXME: remove any
        error: any
      ) {
        logError(error, vm, 'onCleanup()')
      }
    }
  }
  // cleanup before running getter again
  /**
   * 在getter回调执行之前，进行一次清理
   */
  const runCleanup = () => {
    if (cleanup) {
      cleanup()
      cleanup = null
    }
  }
  //#endregion

  // 创建调度器？
  const createScheduler = <T extends Function>(fn: T): T => {
    // 同步watcher立即执行
    if (
      isSync ||
      /* without a current active instance, ignore pre|post mode */ vm ===
        fallbackVM
    ) {
      return fn
    }
    // 否则加入队列
    return ((...args: any[]) =>
      queueFlushJob(
        vm,
        () => {
          fn(...args)
        },
        flushMode as 'pre' | 'post'
      )) as unknown as T
  }

  // effect watch
  // TODO: 没有cb，说明是effect watch？
  if (cb === null) {
    let running = false
    const getter = () => {
      // preventing the watch callback being call in the same execution
      if (running) {
        return
      }
      try {
        running = true
        ;(source as WatchEffect)(registerCleanup)
      } finally {
        running = false
      }
    }
    const watcher = createVueWatcher(vm, getter, noopFn, {
      deep: options.deep || false,
      sync: isSync,
      before: runCleanup,
    })

    patchWatcherTeardown(watcher, runCleanup)

    // enable the watcher update
    watcher.lazy = false
    const originGet = watcher.get.bind(watcher)

    // always run watchEffect
    watcher.get = createScheduler(originGet)

    // 直接返回，不必再做其他事情了
    return () => {
      watcher.teardown()
    }
  }

  let deep = options.deep
  let isMultiSource = false

  let getter: () => any
  if (isRef(source)) {
    getter = () => source.value
  } else if (isReactive(source)) {
    getter = () => source
    deep = true
  } else if (isArray(source)) {
    isMultiSource = true
    getter = () =>
      source.map((s) => {
        if (isRef(s)) {
          return s.value
        } else if (isReactive(s)) {
          return traverse(s)
        } else if (isFunction(s)) {
          return s()
        } else {
          __DEV__ &&
            warn(
              `Invalid watch source: ${JSON.stringify(s)}.
          A watch source can only be a getter/effect function, a ref, a reactive object, or an array of these types.`,
              vm
            )
          return noopFn
        }
      })
  } else if (isFunction(source)) {
    getter = source as () => any
  } else {
    getter = noopFn
    __DEV__ &&
      warn(
        `Invalid watch source: ${JSON.stringify(source)}.
      A watch source can only be a getter/effect function, a ref, a reactive object, or an array of these types.`,
        vm
      )
  }

  if (deep) {
    const baseGetter = getter
    getter = () => traverse(baseGetter())
  }

  const applyCb = (n: any, o: any) => {
    if (
      !deep &&
      isMultiSource &&
      n.every((v: any, i: number) => isSame(v, o[i]))
    )
      return
    // cleanup before running cb again
    runCleanup()
    return cb(n, o, registerCleanup)
  }
  let callback = createScheduler(applyCb)
  if (options.immediate) {
    const originalCallback = callback
    // `shiftCallback` is used to handle the first sync effect run.
    // The subsequent callbacks will redirect to `callback`.
    let shiftCallback = (n: any, o: any) => {
      shiftCallback = originalCallback
      // o is undefined on the first call
      return applyCb(n, isArray(n) ? [] : o)
    }
    callback = (n: any, o: any) => {
      return shiftCallback(n, o)
    }
  }

  // @ts-ignore: use undocumented option "sync"
  const stop = vm.$watch(getter, callback, {
    immediate: options.immediate,
    deep: deep,
    sync: isSync,
  })

  // Once again, we have to hack the watcher for proper teardown
  const watcher = vm._watchers[vm._watchers.length - 1]

  // if the return value is reactive and deep:true
  // watch for changes, this might happen when new key is added
  if (isReactive(watcher.value) && watcher.value.__ob__?.dep && deep) {
    watcher.value.__ob__.dep.addSub({
      update() {
        debugger
        // this will force the source to be revaluated and the callback
        // executed if needed
        watcher.run()
      },
    })
  }

  patchWatcherTeardown(watcher, runCleanup)

  return () => {
    stop()
  }
}

/**
 * watchEffect 函数入口
 *
 * 立即执行传入的一个函数，同时响应式追踪其依赖，并在其依赖变更时重新运行该函数。
 * @param effect 函数
 * @param options 监听选项 - 对于watchEffect来说只有flush可配置
 * @returns
 */
export function watchEffect(
  effect: WatchEffect,
  options?: WatchOptionsBase
): WatchStopHandle {
  const opts = getWatchEffectOption(options)
  const vm = getWatcherVM()
  return createWatcher(vm, effect, null, opts)
}

export function watchPostEffect(effect: WatchEffect) {
  return watchEffect(effect, { flush: 'post' })
}

export function watchSyncEffect(effect: WatchEffect) {
  return watchEffect(effect, { flush: 'sync' })
}

//#region watch 函数定义与实现
// overload #1: array of multiple sources + cb
// Readonly constraint helps the callback to correctly infer value types based
// on position in the source array. Otherwise the values will get a union type
// of all possible value types.
export function watch<
  T extends Readonly<WatchSource<unknown>[]>,
  Immediate extends Readonly<boolean> = false
>(
  sources: [...T],
  cb: WatchCallback<MapSources<T>, MapOldSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload #2: single source + cb
export function watch<T, Immediate extends Readonly<boolean> = false>(
  source: WatchSource<T>,
  cb: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload #3: watching reactive object w/ cb
export function watch<
  T extends object,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// implementation
/**
 * watch 函数入口
 *
 * @param source 监听源
 * @param cb 回调函数
 * @param options 监听选项
 * @returns
 */
export function watch<T = any>(
  source: WatchSource<T> | WatchSource<T>[],
  cb: WatchCallback<T>,
  options?: WatchOptions
): WatchStopHandle {
  let callback: WatchCallback<unknown> | null = null
  if (isFunction(cb)) {
    // source watch
    callback = cb as WatchCallback<unknown>
  } else {
    // effect watch
    if (__DEV__) {
      warn(
        `\`watch(fn, options?)\` signature has been moved to a separate API. ` +
          `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
          `supports \`watch(source, cb, options?) signature.`
      )
    }
    options = cb as Partial<WatchOptions>
    callback = null
  }

  const opts = getWatcherOption(options)
  const vm = getWatcherVM()

  return createWatcher(vm, source, callback, opts)
}
//#endregion

function traverse(value: unknown, seen: Set<unknown> = new Set()) {
  if (!isObject(value) || seen.has(value) || rawSet.has(value)) {
    return value
  }
  seen.add(value)
  if (isRef(value)) {
    traverse(value.value, seen)
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], seen)
    }
  } else if (isSet(value) || isMap(value)) {
    value.forEach((v: any) => {
      traverse(v, seen)
    })
  } else if (isPlainObject(value)) {
    for (const key in value) {
      traverse(value[key], seen)
    }
  }
  return value
}
