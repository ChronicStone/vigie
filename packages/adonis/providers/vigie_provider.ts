import type { ApplicationService } from '@adonisjs/core/types'
import type { VigieConfig } from '../src/define_config.js'
import { flushVigie, initVigie } from '../src/logger.js'
import VigieMiddleware from '../src/middleware.js'

export default class VigieProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    const config = this.app.config.get<VigieConfig | undefined>('vigie')
    if (!config) return
    VigieMiddleware.ignorePaths = config.ignorePaths ?? []
    initVigie(config)
  }

  async shutdown() {
    await flushVigie()
  }
}
