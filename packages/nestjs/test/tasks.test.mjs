import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VigieTask, skipTask } from '../build/src/tasks.js'

class Jobs {
  syncJob() {
    return 42
  }
  async asyncJob() {
    return 'done'
  }
  quietJob() {
    skipTask('NOTHING_TO_DO')
    return 'skipped'
  }
  brokenJob() {
    throw new Error('boom')
  }
}
for (const name of ['syncJob', 'asyncJob', 'quietJob', 'brokenJob']) {
  const d = Object.getOwnPropertyDescriptor(Jobs.prototype, name)
  Object.defineProperty(Jobs.prototype, name, VigieTask(`jobs.${name}`)(Jobs.prototype, name, d))
}
const jobs = new Jobs()

test('a sync task method stays sync', () => {
  assert.equal(jobs.syncJob(), 42)
  assert.equal(jobs.quietJob(), 'skipped')
})

test('an async task method still resolves', async () => {
  const result = jobs.asyncJob()
  assert.ok(result instanceof Promise)
  assert.equal(await result, 'done')
})

test('a throwing task method still throws', () => {
  assert.throws(() => jobs.brokenJob(), /boom/)
})

test('the method keeps its name for Nest metadata', () => {
  assert.equal(jobs.syncJob.name, 'syncJob')
})
