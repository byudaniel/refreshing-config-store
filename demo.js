const ConfigStore = require('./ConfigStore')
const { promisify } = require('util')
const wait = promisify(setTimeout)

const resolver = async () => {
  console.log('***resolver call')
  await wait(1000)

  const time = Date.now()

  return {
    key2: '2:' + time,
    key3: '3:' + time,
  }
}

const config = new ConfigStore({
  staticConfig: {
    key1: '123',
  },
  configResolvers: {
    key2: { resolver, mapper: (result) => result.key2 },
    key3: { resolver, mapper: (result) => result.key3 },
  },
  spreadResolvers: [async () => ({ key4: 4, key5: 5 })],
  log: {
    error: console.log,
  },
})

config.on('error', ({ key, error }) => {
  console.log('key could not be refreshed', key, error)
})

config
  .init()
  .then(() => console.log(config.get('key2')))
  .then(() => console.log(config.get('key3')))
  .then(() => console.log(config.get('key4')))
  .then(() => console.log(config.get('key5')))
