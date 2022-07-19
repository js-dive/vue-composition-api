import type { VueConstructor, VNode } from 'vue'
import { bindCurrentScopeToVM, EffectScope } from './apis/effectScope'
import { ComponentInstance, Data } from './component'
import {
  assert,
  hasOwn,
  warn,
  proxy,
  UnionToIntersection,
  isFunction,
} from './utils'
import type Vue$1 from 'vue'

/**
 * vue 依赖（Vue）
 */
let vueDependency: VueConstructor | undefined = undefined

try {
  const requiredVue = require('vue')
  if (requiredVue && isVue(requiredVue)) {
    vueDependency = requiredVue
  } else if (
    requiredVue &&
    'default' in requiredVue &&
    isVue(requiredVue.default)
  ) {
    vueDependency = requiredVue.default
  }
} catch {
  // not available
}

let vueConstructor: VueConstructor | null = null

/**
 * 当前Vue3实例
 */
let currentInstance: ComponentInternalInstance | null = null
let currentInstanceTracking = true

/**
 * 插件已安装标识
 */
const PluginInstalledFlag = '__composition_api_installed__'

function isVue(obj: any): obj is VueConstructor {
  return obj && isFunction(obj) && obj.name === 'Vue'
}

/**
 * 检查插件是否已安装 - TODO: 通过判断vueConstructor是否存在？
 * @returns 插件是否已安装
 */
export function isPluginInstalled() {
  return !!vueConstructor
}

/**
 * 检查插件是否已注册 - 通过判断vueConstructor是否存在 且 传入的Vue构造函数中是否具有PluginInstalledFlag
 * @returns 插件是否已注册
 */
export function isVueRegistered(Vue: VueConstructor) {
  // resolve issue: https://github.com/vuejs/composition-api/issues/876#issue-1087619365
  return vueConstructor && hasOwn(Vue, PluginInstalledFlag)
}

/**
 * 获得Vue构造函数
 * @returns Vue构造函数
 */
export function getVueConstructor(): VueConstructor {
  if (__DEV__) {
    assert(
      vueConstructor,
      `must call Vue.use(VueCompositionAPI) before using any function.`
    )
  }

  return vueConstructor!
}

// returns registered vue or `vue` dependency
export function getRegisteredVueOrDefault(): VueConstructor {
  let constructor = vueConstructor || vueDependency

  if (__DEV__) {
    assert(constructor, `No vue dependency found.`)
  }

  return constructor!
}

/**
 * 在Vue类上记录一个表示插件已安装的标志位
 * @param Vue
 */
export function setVueConstructor(Vue: VueConstructor) {
  // @ts-ignore
  if (__DEV__ && vueConstructor && Vue.__proto__ !== vueConstructor.__proto__) {
    warn('[vue-composition-api] another instance of Vue installed')
  }
  vueConstructor = Vue
  Object.defineProperty(Vue, PluginInstalledFlag, {
    configurable: true,
    writable: true,
    value: true,
  })
}

/**
 * For `effectScope` to create instance without populate the current instance
 * @internal
 **/
export function withCurrentInstanceTrackingDisabled(fn: () => void) {
  const prev = currentInstanceTracking
  currentInstanceTracking = false
  try {
    fn()
  } finally {
    currentInstanceTracking = prev
  }
}

/**
 * 设置当前Vue2实例 - 内部调用toVue3ComponentInstance转换
 * @param vm
 * @returns
 */
export function setCurrentVue2Instance(vm: ComponentInstance | null) {
  if (!currentInstanceTracking) return
  setCurrentInstance(vm ? toVue3ComponentInstance(vm) : vm)
}

/**
 * 设置当前实例
 */
export function setCurrentInstance(instance: ComponentInternalInstance | null) {
  if (!currentInstanceTracking) return
  // 关闭上一个实例的scope
  const prev = currentInstance
  prev?.scope.off()
  // 开启当前实例的scope
  currentInstance = instance
  currentInstance?.scope.on()
}

export type Slot = (...args: any[]) => VNode[]

export type InternalSlots = {
  [name: string]: Slot | undefined
}

export type ObjectEmitsOptions = Record<
  string,
  ((...args: any[]) => any) | null
>
export type EmitsOptions = ObjectEmitsOptions | string[]

export type EmitFn<
  Options = ObjectEmitsOptions,
  Event extends keyof Options = keyof Options,
  ReturnType extends void | Vue$1 = void
> = Options extends Array<infer V>
  ? (event: V, ...args: any[]) => ReturnType
  : {} extends Options // if the emit is empty object (usually the default value for emit) should be converted to function
  ? (event: string, ...args: any[]) => ReturnType
  : UnionToIntersection<
      {
        [key in Event]: Options[key] extends (...args: infer Args) => any
          ? (event: key, ...args: Args) => ReturnType
          : (event: key, ...args: any[]) => ReturnType
      }[Event]
    >

export type ComponentRenderEmitFn<
  Options = ObjectEmitsOptions,
  Event extends keyof Options = keyof Options,
  T extends Vue$1 | void = void
> = EmitFn<Options, Event, T>

export type Slots = Readonly<InternalSlots>

export interface SetupContext<E extends EmitsOptions = {}> {
  attrs: Data
  slots: Slots
  emit: EmitFn<E>
  /**
   * @deprecated not available in Vue 2
   */
  expose: (exposed?: Record<string, any>) => void

  /**
   * @deprecated not available in Vue 3
   */
  readonly parent: ComponentInstance | null

  /**
   * @deprecated not available in Vue 3
   */
  readonly root: ComponentInstance

  /**
   * @deprecated not available in Vue 3
   */
  readonly listeners: { [key in string]?: Function }

  /**
   * @deprecated not available in Vue 3
   */
  readonly refs: { [key: string]: Vue | Element | Vue[] | Element[] }
}

export interface ComponentPublicInstance {}

/**
 * 我们暴露了在内部实例上的一部分属性，因为它们对于高级的库与工具来说会较为有用。
 *
 * We expose a subset of properties on the internal instance as they are
 * useful for advanced external libraries and tools.
 */
export declare interface ComponentInternalInstance {
  uid: number
  type: Record<string, unknown> // ConcreteComponent
  parent: ComponentInternalInstance | null
  root: ComponentInternalInstance

  //appContext: AppContext

  /**
   * Vnode representing this component in its parent's vdom tree
   */
  vnode: VNode
  /**
   * Root vnode of this component's own vdom tree
   */
  // subTree: VNode // does not exist in Vue 2

  /**
   * The reactive effect for rendering and patching the component. Callable.
   */
  update: Function

  data: Data
  props: Data
  attrs: Data
  refs: Data
  emit: EmitFn

  slots: InternalSlots
  emitted: Record<string, boolean> | null

  /**
   * Vue2 组件实例
   */
  proxy: ComponentInstance

  isMounted: boolean
  isUnmounted: boolean
  isDeactivated: boolean

  /**
   * @internal
   */
  scope: EffectScope

  /**
   * @internal
   */
  setupContext: SetupContext | null
}

/**
 * 获取当前实例
 * 仅在组件setup以及生命周期函数期间能够拿到当前实例
 * @returns
 */
export function getCurrentInstance() {
  return currentInstance
}

const instanceMapCache = new WeakMap<
  ComponentInstance,
  ComponentInternalInstance
>()

/**
 * 将Vue2组件转换到Vue3组件
 * @param vm Vue2 组件实例
 * @returns Vue3 组件实例
 */
export function toVue3ComponentInstance(
  vm: ComponentInstance
): ComponentInternalInstance {
  if (instanceMapCache.has(vm)) {
    return instanceMapCache.get(vm)!
  }

  // 内部instance
  const instance: ComponentInternalInstance = {
    proxy: vm,
    update: vm.$forceUpdate,
    type: vm.$options,
    uid: vm._uid,

    // $emit is defined on prototype and it expected to be bound
    emit: vm.$emit.bind(vm),

    parent: null,
    root: null!, // to be immediately set
  } as unknown as ComponentInternalInstance

  // 将当前作用域绑定到vue3实例上
  // EffectScope入口
  bindCurrentScopeToVM(instance)

  // map vm.$props =
  const instanceProps = [
    'data',
    'props',
    'attrs',
    'refs',
    'vnode',
    'slots',
  ] as const

  // 代理一些属性到内部instance上
  instanceProps.forEach((prop) => {
    proxy(instance, prop, {
      get() {
        return (vm as any)[`$${prop}`]
      },
    })
  })

  proxy(instance, 'isMounted', {
    get() {
      // @ts-expect-error private api
      return vm._isMounted
    },
  })

  proxy(instance, 'isUnmounted', {
    get() {
      // @ts-expect-error private api
      return vm._isDestroyed
    },
  })

  proxy(instance, 'isDeactivated', {
    get() {
      // @ts-expect-error private api
      return vm._inactive
    },
  })

  proxy(instance, 'emitted', {
    get() {
      // @ts-expect-error private api
      return vm._events
    },
  })

  instanceMapCache.set(vm, instance)

  if (vm.$parent) {
    instance.parent = toVue3ComponentInstance(vm.$parent)
  }

  if (vm.$root) {
    instance.root = toVue3ComponentInstance(vm.$root)
  }

  return instance
}
