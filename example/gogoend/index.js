import Vue from 'vue'
import VueCompositionAPI, {
  ref,
  createApp,
  onMounted,
  defineComponent,
  watch,
  effectScope,
  watchEffect,
  computed,
} from '@vue/composition-api'

Vue.use(VueCompositionAPI)

// ----- effectScope相关开始 -----
const scope = effectScope()
const counter = ref(1)
scope.run(() => {
  const doubled = computed(() => counter.value * 2)

  watch(doubled, () => console.log(doubled.value))

  watchEffect(() => console.log('Count: ', doubled.value))
})
// 处理掉当前作用域内的所有 effect
scope.stop()
// ----- effectScope相关结束 -----

const App = defineComponent({
  template: `
<div>
<div>{{ msg }} {{ msg1 }}</div>
<button @click="counter++">{{ counter }}</button>
</div>
`,
  setup() {
    const msg = ref('666')
    console.log(msg)

    watch(
      msg,
      (...args) => {
        debugger
        console.log('w1', ...args)
      },
      {}
    )
    watch(
      msg,
      (...args) => {
        debugger
        console.log('w2', ...args)
      },
      {
        immediate: true,
      }
    )
    msg.value = '777'

    onMounted(() => {
      console.log(1)
    })
    onMounted(() => {
      console.log(2)
    })
    return {
      msg,
      counter,
    }
  },
  data() {
    return {
      msg1: '777',
    }
  },
})

createApp(App).mount('#app')
