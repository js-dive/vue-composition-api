import Vue from 'vue'
import VueCompositionAPI, {
  ref,
  createApp,
  onMounted,
} from '@vue/composition-api'
Vue.use(VueCompositionAPI)

const App = {
  template: `
<div>{{ msg }} {{ msg1 }}</div>
`,
  setup() {
    debugger
    const msg = ref('666')
    console.log(msg)

    onMounted(() => {
      console.log(1)
      debugger
    })
    onMounted(() => {
      console.log(2)
      debugger
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
}

createApp(App).mount('#app')
