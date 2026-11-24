import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EMPTY_CREDENTIAL_OPTIONS } from './constants.ts'
import { allCredentialAccess, defaultCredentialAccess } from './credentialAccess.ts'
import { buildMcpServerCredentialSections } from './credentialSectionsC.ts'

test('custom MCP servers stay opt-in in defaultCredentialAccess and appear in sections', () => {
  const options = {
    ...EMPTY_CREDENTIAL_OPTIONS,
    mcpServers: [{ id: '65f000000000000000000001', name: 'Homelab', url: 'https://1.1.1.1/mcp' }],
  }

  assert.deepEqual(defaultCredentialAccess(options).mcpServerIds, [])
  assert.deepEqual(allCredentialAccess(options).mcpServerIds, ['65f000000000000000000001'])
  assert.deepEqual(buildMcpServerCredentialSections(options.mcpServers), [
    {
      id: 'mcp',
      provider: 'mcp',
      title: 'MCP servers',
      items: [
        {
          id: '65f000000000000000000001',
          label: 'Homelab',
          sublabel: 'https://1.1.1.1/mcp',
        },
      ],
    },
  ])
})
