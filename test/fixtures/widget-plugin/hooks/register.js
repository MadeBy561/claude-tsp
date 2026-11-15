// A test plugin for a host's plugin UI: a band above the prompt with a
// counter and buttons, a pane, a notification and a log line.
let count = 0

function band($, e, next) {
  const { Box, Text, Button } = $.ui.resolve(e)
  return h(Box, { flexDirection: 'row', gap: 1 },
    h(Text, { bold: true }, 'widget'),
    h(Text, {}, 'count ' + count),
    h(Button, { key: 'bump', label: 'Add one', onPress: () => { count += 1; $.ui.invalidate('ui.render') } }),
    h(Button, { key: 'pane', label: 'Open pane', onPress: async () => { const opened = await $.ui.open({ id: 'clock', title: 'Clock' }); if (!opened.isPlaced) $.ui.log('pane not placed: ' + opened.reason) } }),
    h(Button, { key: 'tell', label: 'Notify', onPress: () => { void $.ui.notify('hello from the widget', { title: 'Widget' }); $.ui.log('widget logged a line') } }))
}

function pane($, e, next) {
  const { Box, Text } = $.ui.resolve(e)
  return h(Box, { flexDirection: 'column' },
    h(Text, { bold: true }, 'Clock pane'),
    h(Text, {}, 'The counter stands at ' + count + '.'))
}

export function register(on) {
  on('ui.render', { component: 'AbovePrompt' }, band)
  on('ui.render', { component: 'Pane' }, pane)
}
