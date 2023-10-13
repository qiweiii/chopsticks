import { EventEmitter } from 'eventemitter3'
import {
  ProviderInterface,
  ProviderInterfaceCallback,
  ProviderInterfaceEmitCb,
  ProviderInterfaceEmitted,
  ProviderStats,
} from '@polkadot/rpc-provider/types'

import { defaultLogger } from './logger'

interface SubscriptionHandler {
  callback: ProviderInterfaceCallback
  type: string
}

interface Subscription extends SubscriptionHandler {
  method: string
  params: unknown[]
  onCancel: () => void
}

export interface ChopsticksProviderProps {
  /** upstream endpoint */
  endpoint: string | undefined
  /** default to latest block */
  blockHash?: string
  dbPath?: string
}

/**
 * A provider for ApiPromise.
 *
 * Currectly only support browser environment.
 */
export class ChopsticksProvider implements ProviderInterface {
  #isConnected = false
  #eventemitter: EventEmitter
  #isReadyPromise: Promise<void>
  #endpoint: string
  readonly stats?: ProviderStats
  #subscriptions: Record<string, Subscription> = {}
  #worker: Worker | undefined
  #blockHash: string | undefined
  #dbPath: string | undefined

  constructor({ endpoint, blockHash, dbPath }: ChopsticksProviderProps) {
    if (!endpoint) {
      throw new Error('ChopsticksProvider requires the upstream endpoint')
    }
    this.#endpoint = endpoint
    this.#blockHash = blockHash
    this.#dbPath = dbPath

    this.#eventemitter = new EventEmitter()

    this.#isReadyPromise = new Promise((resolve, reject): void => {
      this.#eventemitter.once('connected', (): void => {
        defaultLogger.info('[Chopsticks provider] isReadyPromise: connected.')
        resolve()
      })
      this.#eventemitter.once('error', reject)
    })

    if (globalThis.Worker) {
      const chopsticksWorker = new Worker(new URL('./chopsticks-worker.ts', import.meta.url), { type: 'module' })
      this.#worker = chopsticksWorker
      chopsticksWorker.onmessage = (e) => {
        switch (e.data.type) {
          case 'connection':
            defaultLogger.info('[Chopsticks provider] onMessage: connection.', e.data)
            if (e.data.connected) {
              this.#isConnected = true
              this.#eventemitter.emit('connected')
            } else {
              this.#isConnected = false
              this.#eventemitter.emit('error', new Error('Unable to connect to the chain'))
              defaultLogger.error(`Unable to connect to the chain: ${e.data.message}`)
            }
            break
          case 'subscribe-callback':
            this.#subscriptions[e.data.id].callback(null, e.data.result)
            break
          case 'unsubscribe-callback':
            this.#subscriptions[e.data.id].onCancel()
            delete this.#subscriptions[e.data.id]
            break
          default:
            break
        }
      }
    }

    this.connect()
  }

  get hasSubscriptions(): boolean {
    return true
  }

  get isClonable(): boolean {
    return true
  }

  get isConnected(): boolean {
    return this.#isConnected
  }

  get isReady(): Promise<void> {
    return this.#isReadyPromise
  }

  clone = (): ProviderInterface => {
    return new ChopsticksProvider({ endpoint: this.#endpoint })
  }

  connect = async (): Promise<void> => {
    if (this.#isConnected) {
      return
    }
    this.#worker?.postMessage({
      type: 'connect',
      endpoint: this.#endpoint,
      blockHash: this.#blockHash,
      dbPath: this.#dbPath,
    })
  }

  disconnect = async (): Promise<void> => {
    this.#worker?.postMessage({ type: 'disconnect' })
    this.#isConnected = false
    this.#eventemitter.emit('disconnected')
  }

  on = (type: ProviderInterfaceEmitted, sub: ProviderInterfaceEmitCb): (() => void) => {
    this.#eventemitter.on(type, sub)

    return (): void => {
      this.#eventemitter.removeListener(type, sub)
    }
  }

  send = async <T>(
    method: string,
    params: unknown[],
    _isCacheable?: boolean,
    subscription?: SubscriptionHandler,
  ): Promise<T> => {
    await this.isReady
    defaultLogger.info('[Chopsticks provider] send:', { method, params })
    if (subscription) {
      const subid = `${subscription.type}::${method}`
      this.#subscriptions[subid] = {
        callback: subscription.callback,
        method,
        params,
        type: subscription.type,
        onCancel: (): void => {},
      }
    }

    const resultPromise = new Promise<T>((resolve, _reject): void => {
      this.#worker!.onmessage = (e) => {
        defaultLogger.info('[Chopsticks provider] resultPromise:', { method, params, data: e.data })
        if (e.data.type === 'send-result' && method === e.data.id) {
          resolve(JSON.parse(e.data.result))
        }
      }
    })

    this.#worker?.postMessage({
      type: 'send',
      method,
      id: method,
      params,
      subid: subscription?.type,
    })

    const result = await resultPromise

    return result
  }

  subscribe(
    type: string,
    method: string,
    params: unknown[],
    callback: ProviderInterfaceCallback,
  ): Promise<number | string> {
    return this.send<string | number>(method, params, false, { callback, type })
  }

  async unsubscribe(type: string, method: string, id: number | string): Promise<boolean> {
    const subscription = `${type}::${id}`

    if (!this.#subscriptions[subscription]) {
      defaultLogger.error(`Unable to find active subscription=${subscription}`)
      return false
    }

    delete this.#subscriptions[subscription]

    try {
      return this.isConnected ? this.send<boolean>(method, [id]) : true
    } catch {
      return false
    }
  }
}
