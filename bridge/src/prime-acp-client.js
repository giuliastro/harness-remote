import { AcpClient } from "./acp-client.js"

/**
 * Prime Agent's ACP mode deliberately implements one session per connection and does not
 * implement session/list. The bridge still needs an empty listing before it can create its
 * first owned session, so keep that Prime-specific protocol difference out of the generic client.
 */
export class PrimeAcpClient extends AcpClient {
  async listSessions() {
    await this.start()
    return []
  }
}
