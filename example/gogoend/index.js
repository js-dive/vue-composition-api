import Vue from 'vue'
import VueCompositionAPI, { ref, createApp } from '@vue/composition-api'
Vue.use(VueCompositionAPI)

const App = {
  template: `
<div>{{ msg }} {{ msg1 }}</div>
`,
  setup() {
    const msg = ref('666')
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
