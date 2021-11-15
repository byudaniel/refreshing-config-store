const NodeCache = require('node-cache')
const promiseRetry = require('promise-retry')
const debounce = require('debounce-promise')
const EventEmitter = require('events')

const DEFAULT_KEY_TTL = 600
const RESOLVER_DEBOUNCE_MS = 1000

const refreshKey = Symbol('refreshKey')

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
      mapper: configResolvers[key].mapper,
    }
  })

  return configResolvers
}

class ConfigStore extends EventEmitter {
  #cache = null
  #staticConfig = null
  #keyTtl = 0
  #keyRefreshRetries = 10
  #configResolvers = null
  #proxiedThis = null
  #spreadResolvers = []
  #initPromise = null

  constructor({
    staticConfig,
    configResolvers,
    spreadResolvers,
    defaultTtl = DEFAULT_KEY_TTL,
    keyCheckPeriod,
    keyRefreshRetries = 10,
  }) {
    super()
    this.#keyTtl = defaultTtl
    this.#keyRefreshRetries = keyRefreshRetries

    this.#cache = new NodeCache({
      deleteOnExpire: false,
      stdTTL: this.#keyTtl,
      checkperiod: keyCheckPeriod ? keyCheckPeriod : this.#keyTtl / 3,
    })
    this.#staticConfig = staticConfig || {}
    this.#configResolvers = debounceConfigResolvers(configResolvers)
    this.#spreadResolvers = spreadResolvers || []

    this.#cache.on('expired', (key) => {
      if (configResolvers[key]) {
        this[refreshKey](key).catch((error) =>
          this.emit('error', { key, error })
        )
      } else {
        this.#spreadResolvers.forEach(async (resolver) => {
          const result = await resolver()
          Object.entries(result).forEach(([key, value]) =>
            this.set(key, value, this.#keyTtl)
          )
        })
      }
    })

    this.#proxiedThis = new Proxy(this, {
      get: function (target, prop) {
        if (target[prop] !== undefined) {
          return target[prop].bind(target)
        }

        return target.get(prop)
      },
    })

    return this.#proxiedThis
  }

  init() {
    if (!this.#initPromise) {
      this.#initPromise = Promise.all([
        ...Object.keys(this.#configResolvers).map(this[refreshKey].bind(this)),
        ...this.#spreadResolvers.map(async (resolver) => {
          const result = await resolver()
          Object.entries(result).forEach(([key, value]) =>
            this.set(key, value, this.#keyTtl)
          )
        }),
      ]).catch((err) => {
        this.#initPromise = null
        throw err
      })
    }

    return this.#initPromise
  }

  [refreshKey](key) {
    const func = this.#configResolvers[key].resolver
    const mapper = this.#configResolvers[key].mapper
    const ttl =
      this.#configResolvers[key].ttl || this.#configResolvers[key].ttl === 0
        ? this.#configResolvers[key].ttl
        : this.#keyTtl

    return promiseRetry((retry) => func().catch(retry), {
      retries: this.#keyRefreshRetries,
    }).then((result) => {
      if (typeof mapper === 'function') {
        this.#cache.set(key, mapper(result, this.#proxiedThis))
        return
      }
      this.#cache.set(key, result, ttl)
    })
  }

  get(key) {
    const value = this.#cache.get(key)

    if (value !== undefined) {
      return value
    }

    return this.#staticConfig[key]
  }

  set(key, value, ttl) {
    this.#cache.set(key, value, ttl)
  }

  toJSON() {
    return {
      ...this.#staticConfig,
      ...this.#cache.mget(this.#cache.keys()),
    }
  }
}

module.exports = ConfigStore
