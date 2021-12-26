import '../../node_modules/vue/dist/vue.js'

import '../../dist/vue-composition-api.js'

const App = {
  template: `
<div>{{ msg }} {{ msg1 }}</div>
`,
  setup() {
    const msg = VueCompositionAPI.ref('666')
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

VueCompositionAPI.createApp(App).mount('#app')
