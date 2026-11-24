import { beforeEach, describe, expect, test } from 'bun:test'

import { useAgentDb } from '@/lib/test/doubles/agent-db'
import { useArchiveCleanup } from '@/lib/test/doubles/archive-cleanup'
import { useIdentity } from '@/lib/test/doubles/identity'

import { createPreviewToolLog } from '@/routes/agent/chat-preview-tool-log'
import {
  consumePreviewToolPresentation,
  handlePreviewToolUpdate,
} from '@/routes/agent/chat-preview-tool-update'

import { parseToolUpdate } from '../preview-agent-update'
import { createPreviewAssistantPartAccumulator } from '../preview-transcript'
import { threadToolModule } from './threads'

import type { PreviewToolContext } from '../preview-tool-context'
import type { AgentConversation } from '@/lib/agent/db'

const SUBTASK_ID = '00000000-0000-4000-8000-000000000001'
const FOREIGN_ID = '00000000-0000-4000-8000-000000000002'
const CHANNEL_ID = '00000000-0000-4000-8000-000000000003'

const archivedCalls: [string, boolean][] = []
const cleanedCalls: string[][] = []

const baseConversation = (
  overrides: Partial<AgentConversation> & Pick<AgentConversation, 'sessionId'>,
): AgentConversation => ({
  userId: 'owner',
  teamId: 'team',
  title: 'Source',
  firstMessage: '',
  messageCount: 1,
  createdAt: new Date(),
  lastActiveAt: new Date(),
  credentialAccess: { updatedAt: new Date(), updatedBy: 'owner' },
  ...overrides,
})

const conversationsById: Record<string, AgentConversation> = {
  source: baseConversation({ sessionId: 'source' }),
  [SUBTASK_ID]: baseConversation({
    sessionId: SUBTASK_ID,
    parentSessionId: 'source',
    title: 'Subtask',
  }),
  [FOREIGN_ID]: baseConversation({ sessionId: FOREIGN_ID, userId: 'other', title: 'Foreign' }),
  [CHANNEL_ID]: baseConversation({ sessionId: CHANNEL_ID, kind: 'channel', title: 'Group' }),
}

beforeEach(() => {
  archivedCalls.length = 0
  cleanedCalls.length = 0
})

useIdentity({ getTeamMembership: async () => ({ role: 'MEMBER' }) })
useArchiveCleanup({
  cleanUpArchived: async (sessionIds) => {
    cleanedCalls.push(sessionIds)
  },
})
useAgentDb({
  getConversationBySessionId: async (id) => conversationsById[id] ?? null,
  setConversationArchived: async (sessionId, archived) => {
    archivedCalls.push([sessionId, archived])

    return { sessionIds: [sessionId] }
  },
})

test('a refused change reaches the agent as its reason, not an internal error', async () => {
  const ctx = { userId: 'owner', teamId: 'team', sessionId: 'source', locale: 'en' }
  const tools = threadToolModule().handlers(ctx as PreviewToolContext)
  const result = await tools.update_thread?.({
    label: 'x',
    threadId: '00000000-0000-4000-8000-000000000000',
    fullAccess: false,
  })

  expect(result).toMatchObject({ isError: true })
  expect(JSON.stringify(result)).toContain('another conversation you own')
})

test.each(['grant', 'revoke'])(
  "update_thread has no %s: a thread uses its top conversation's credentials",
  async (key) => {
    const ctx = { userId: 'owner', teamId: 'team', sessionId: 'source', locale: 'en' }
    const tools = threadToolModule().handlers(ctx as PreviewToolContext)
    const result = await tools.update_thread?.({
      label: 'x',
      threadId: '00000000-0000-4000-8000-000000000000',
      [key]: [{ provider: 'aws', id: 'role-1' }],
    })

    expect(result).toMatchObject({ isError: true })
    expect(JSON.stringify(result)).toContain('unrecognized_keys')
  },
)

test.each([false, true])(
  'a thread message shows one card, the stored ACP call, with revealed permission=%s',
  async (permission) => {
    const log = createPreviewToolLog()
    const order = createPreviewAssistantPartAccumulator()
    const frames: Record<string, unknown>[] = []
    const emit = (frame: Record<string, unknown>) => frames.push(frame)
    const update = (payload: Record<string, unknown>) => {
      const parsed = parseToolUpdate('acp-1', payload)

      if (parsed.kind !== 'tool') throw new Error('expected tool')
      handlePreviewToolUpdate(emit, log, parsed)
      order.appendTool('acp-1')
    }
    const input = {
      label: 'x',
      threadId: '00000000-0000-4000-8000-000000000000',
      prompt: 'status?',
    }

    update({
      title: 'mcp__nuphos-tools__send_message_to_thread',
      status: 'pending',
      rawInput: input,
    })
    // Claude Code asks before an MCP call; the bridge reveals the card even when Full Access allows it.
    if (permission)
      handlePreviewToolUpdate(emit, log, {
        kind: 'tool',
        toolCallId: 'acp-1',
        title: 'send_message_to_thread',
        status: 'pending',
        revealed: true,
      })
    const ctx = { userId: 'owner', teamId: 'team', sessionId: 'source', locale: 'en' }
    const tools = threadToolModule({
      publish: async (_ctx, frame) => {
        // A slow input frame must still land before the result.
        if (frame.type === 'tool-input-available') await Bun.sleep(20)
        if (!consumePreviewToolPresentation(emit, log, frame)) emit(frame)
      },
    }).handlers(ctx as PreviewToolContext)
    const result = await tools.send_message_to_thread?.(input)

    update({ status: 'completed', rawOutput: { result } })

    const cards = frames.filter((frame) => frame.type === 'tool-input-available')

    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ toolCallId: 'acp-1', toolName: 'send_message_to_thread' })
    expect(frames.at(-1)).toMatchObject({ type: 'tool-output-error', toolCallId: 'acp-1' })
    expect(order.materialize(log.list())).toHaveLength(1)
  },
)

describe('archive_thread tool', () => {
  const ctx = { userId: 'owner', teamId: 'team', sessionId: 'source', locale: 'en' }

  test('archives an owned sub-task and runs cleanup', async () => {
    const tools = threadToolModule().handlers(ctx as PreviewToolContext)
    const result = await tools.archive_thread?.({
      label: 'Archive completed sub-task',
      threadId: SUBTASK_ID,
    })

    expect(result).not.toMatchObject({ isError: true })
    expect(JSON.stringify(result)).toContain(SUBTASK_ID)
    expect(archivedCalls).toEqual([[SUBTASK_ID, true]])
    expect(cleanedCalls).toEqual([[SUBTASK_ID]])
  })

  test('refuses foreign-owner threads and channels without archiving', async () => {
    const tools = threadToolModule().handlers(ctx as PreviewToolContext)
    const foreign = await tools.archive_thread?.({
      label: 'Archive foreign thread',
      threadId: FOREIGN_ID,
    })
    const channel = await tools.archive_thread?.({
      label: 'Archive channel',
      threadId: CHANNEL_ID,
    })

    expect(foreign).toMatchObject({ isError: true })
    expect(JSON.stringify(foreign)).toContain('Target must')
    expect(channel).toMatchObject({ isError: true })
    expect(JSON.stringify(channel)).toContain('channel')
    expect(archivedCalls).toEqual([])
    expect(cleanedCalls).toEqual([])
  })

  test('rejects an invalid threadId', async () => {
    const tools = threadToolModule().handlers(ctx as PreviewToolContext)
    const result = await tools.archive_thread?.({
      label: 'Archive invalid id',
      threadId: 'not-a-uuid',
    })

    expect(result).toMatchObject({ isError: true })
    expect(archivedCalls).toEqual([])
    expect(cleanedCalls).toEqual([])
  })
})
