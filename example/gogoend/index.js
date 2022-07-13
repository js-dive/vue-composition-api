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
        console.log(...args)
      },
      {
        immediate: true,
      }
    )
    watch(
      msg,
      (...args) => {
        debugger
        console.log(...args)
      },
      {
        immediate: true,
      }
    )

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
