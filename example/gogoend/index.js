import Vue from 'vue'
import VueCompositionAPI, {
  ref,
  createApp,
  onMounted,
  defineComponent,
  watch,
} from '@vue/composition-api'

Vue.use(VueCompositionAPI)

const App = defineComponent({
  template: `
<div>{{ msg }} {{ msg1 }}</div>
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
    }
  },
  data() {
    return {
      msg1: '777',
    }
  },
})

createApp(App).mount('#app')
