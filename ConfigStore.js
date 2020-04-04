const NodeCache = require('node-cache')
const promiseRetry = require('promise-retry')
const debounce = require('debounce-promise')
const EventEmitter = require('events')

const DEFAULT_KEY_TTL = 600
const RESOLVER_DEBOUNCE_MS = 1000

function debounceConfigResolvers(configResolvers) {
  const funcMap = new Map()
  Object.entries(configResolvers).forEach(([key, resolverConfig]) => {
    const resolver =
      typeof resolverConfig === 'function'
        ? resolverConfig
        : resolverConfig.resolver
    let debouncedResolver = funcMap.get(resolver)
    if (!debouncedResolver) {
      debouncedResolver = debounce(resolver, RESOLVER_DEBOUNCE_MS)
      funcMap.set(resolver, debouncedResolver)
    }
    configResolvers[key] = {
      resolver: debouncedResolver,
      mapper: configResolvers[key].mapper
    }
  })

  return configResolvers
}

class ConfigStore extends EventEmitter {
  constructor({
    staticConfig,
    configResolvers,
    defaultTtl = DEFAULT_KEY_TTL,
    keyCheckPeriod,
    keyRefreshRetries = 10
  }) {
    super()
    this.keyTtl = defaultTtl
    this.keyCheckPeriod = keyCheckPeriod ? keyCheckPeriod : this.keyTtl / 3
    this.keyRefreshRetries = keyRefreshRetries

    this.cache = new NodeCache({
      deleteOnExpire: false,
      stdTTL: this.keyTtl,
      checkperiod: this.keyTtl / 3
    })
    this.staticConfig = staticConfig || {}
    this.configResolvers = debounceConfigResolvers(configResolvers)

    this.cache.on('expired', key => {
      if (configResolvers[key]) {
        this.refreshKey(key).catch(error => this.emit('error', { key, error }))
      }
    })
  }

  init() {
    return Promise.all(
      Object.keys(this.configResolvers).map(this.refreshKey.bind(this))
    )
  }

  refreshKey(key) {
    const func = this.configResolvers[key].resolver
    const mapper = this.configResolvers[key].mapper
    const ttl =
      this.configResolvers[key].ttl || this.configResolvers[key].ttl === 0
        ? this.configResolvers[key].ttl
        : this.keyTtl

    return promiseRetry(retry => func().catch(retry), {
      retries: this.keyRefreshRetries
    }).then(result => {
      if (typeof mapper === 'function') {
        this.cache.set(key, mapper(result))
        return
      }
      this.cache.set(key, result, ttl)
    })
  }

  get(key) {
    const value = this.staticConfig[key]
    if (value || value === 0) {
      return value
    }

    return this.cache.get(key)
  }

  set(key, value, ttl) {
    this.cache.set(key, value, ttl)
  }
}

module.exports = ConfigStore
