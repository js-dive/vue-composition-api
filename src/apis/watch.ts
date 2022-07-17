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

// 用于回落的vm
// getWatcherVM、createScheduler会使用
let fallbackVM: ComponentInstance

function flushPreQueue(this: any) {
  flushQueue(this, WatcherPreFlushQueueKey)
}

function flushPostQueue(this: any) {
  flushQueue(this, WatcherPostFlushQueueKey)
}

/**
 * 检查vm中是否存在composotion-api queue专用的属性
 * @param vm
 * @returns
 */
function hasWatchEnv(vm: any) {
  return vm[WatcherPreFlushQueueKey] !== undefined
}

/**
 * 初始化vm watch的环境
 * 看起来做了下面两件事：
 * 1. 在vm中加入WatcherPreFlushQueueKey、WatcherPostFlushQueueKey —— 它们对应的值是数组
 * 2. 设置在beforeUpdate、updated生命周期将要做的事情，即分别冲刷对应队列
 *
 * @param vm Vue组件
 */
function installWatchEnv(vm: any) {
  // 加入WatcherPreFlushQueueKey、WatcherPostFlushQueueKey属性，并设置值为数组的逻辑
  vm[WatcherPreFlushQueueKey] = []
  vm[WatcherPostFlushQueueKey] = []

  // 设置组件beforeUpdate、updated生命周期执行前后，冲刷一次队列的逻辑
  vm.$on('hook:beforeUpdate', flushPreQueue)
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

/**
 * 获得当前正在激活的Vue实例
 * @returns
 */
function getWatcherVM() {
  let vm = getCurrentScopeVM()
  // 如果当前vm不存在，就生成一个新的vm
  if (!vm) {
    if (!fallbackVM) {
      fallbackVM = defineComponentInstance(getVueConstructor())
    }
    vm = fallbackVM
  }
  // 如果vm中不存在composition-api queue专用的属性，就安装一下
  else if (!hasWatchEnv(vm)) {
    installWatchEnv(vm)
  }
  return vm
}

/**
 * 冲刷队列，冲刷结束后将队列长度设置为0
 * @param vm
 * @param key
 */
function flushQueue(vm: any, key: any) {
  const queue = vm[key]
  for (let index = 0; index < queue.length; index++) {
    queue[index]()
  }
  // 队列冲刷完了以后，将队列长度设置为0
  queue.length = 0
}

/**
 * 将任务排到冲刷队列中，并在nextTick后冲刷掉所有任务
 * @param vm
 * @param fn 回调函数
 * @param mode 清空模式
 */
function queueFlushJob(
  vm: any,
  fn: () => void,
  mode: Exclude<FlushMode, 'sync'>
) {
  // flush all when beforeUpdate and updated are not fired
  /**
   * 即使 beforeUpdate 与 updated 未触发，也冲刷一次队列
   *
   * TODO: 正常情况下，队列应该是 beforeUpdate 与 updated 执行时会冲刷一次的
   * 目前来看即使没有走这两个生命周期，也会冲刷一次队列
   */
  const fallbackFlush = () => {
    // 真正的冲刷逻辑是在nextTick后才执行的，在此之前可以往队列里排任务
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

  /**
   * 预先确定好在nextTick时冲刷一次队列，并在此之前排任务的逻辑
   *
   * TODO: 真正冲刷的时候似乎就不管flush值是post还是pre了，只按照排序顺序执行
   */
  switch (mode) {
    case 'pre':
      fallbackFlush() // 预定好在nextTick时冲刷一次队列
      vm[WatcherPreFlushQueueKey].push(fn) // 在真正的冲刷逻辑执行此之前，我们可以把任务先排上
      break
    case 'post':
      fallbackFlush() // 预定好在nextTick时冲刷一次队列
      vm[WatcherPostFlushQueueKey].push(fn) // 在真正的冲刷逻辑执行此之前，我们可以把任务先排上
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
  /**
   * 设置cleanup函数
   * @param fn
   */
  const registerCleanup: InvalidateCbRegistrator = (fn: () => void) => {
    cleanup = () => {
      try {
        fn() // TODO: 好像没有任何地方有传入fn这个参数？
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

  /**
   * 创建调度器
   *
   * 如果watch配置中，isSync为true，或者当前没有正在激活的vm实例，那么就返回函数本身，即认为任务（？）不必进入冲刷队列，应当立即执行
   * 否则返回一个将当前函数插入到冲刷队列中的函数，即认为任务（？）应当延后执行
   **/
  const createScheduler = <T extends Function>(fn: T): T => {
    if (
      isSync ||
      /* without a current active instance, ignore pre|post mode */
      /* 没有正在激活的vm实例的情况下，忽略 pre|post 配置 */ vm === fallbackVM
    ) {
      return fn
    }
    // 否则加入冲刷队列
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
  // 如果是ref则返回其中的value
  if (isRef(source)) {
    getter = () => source.value
  }
  // 如果经过reactive处理，就返回这个值
  else if (isReactive(source)) {
    getter = () => source
    deep = true // TODO: 为什么要把deep设为true？或许，因为source是个对象，因此deep应该设置为true；或许应该只观测其中对象第一层的变化？
  }
  // 如果是个数组，那就说明是有多个监听源
  else if (isArray(source)) {
    isMultiSource = true
    getter = () =>
      // 因此对这些监听源再各自处理一次
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
  }
  // 如果是个函数
  else if (isFunction(source)) {
    getter = source as () => any
  }
  // 其它神经的情况 - watch源无效
  else {
    getter = noopFn
    __DEV__ &&
      warn(
        `Invalid watch source: ${JSON.stringify(source)}.
      A watch source can only be a getter/effect function, a ref, a reactive object, or an array of these types.`,
        vm
      )
  }

  // TODO: 如果deep为true的话，就遍历一下整个对象，重新设置getter？
  if (deep) {
    const baseGetter = getter
    getter = () => traverse(baseGetter())
  }

  /**
   * 我们所传入的watcher回调由此函数调用
   *
   * @param n 旧值
   * @param o 新值
   * @returns 我们所传入的callback的返回值
   */
  const applyCb = (n: any, o: any) => {
    if (
      // TODO: 不是deep就不用调用了？
      !deep &&
      // 如果监听源是个数组且每一项都相同，也不必调用了
      isMultiSource &&
      n.every((v: any, i: number) => isSame(v, o[i]))
    )
      return
    // cleanup before running cb again
    runCleanup()
    return cb(n, o, registerCleanup)
  }
  /**
   * callback即最终要设置的、$watch的参数
   */
  let callback = createScheduler(applyCb)
  // TODO: 立即调用时的逻辑
  if (options.immediate) {
    // 存一下原始的callback
    const originalCallback = callback
    // shiftCallback用来处理第一次同步的副作用执行
    // 在第一次执行过后，shiftCallback的值将变为原来的callback，此时即可恢复主线的watcher回调函数
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

  // 停止监听
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
        // this will force the source to be revaluated and the callback
        // executed if needed
        watcher.run()
      },
    })
  }

  // 将watcher中的teardown方法进行一些额外处理，使得Vue能够在卸载时运行runCleanup()
  patchWatcherTeardown(watcher, runCleanup)

  // 返回一个函数，用于停止监听
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

  // 真正的创建watcher的逻辑
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
