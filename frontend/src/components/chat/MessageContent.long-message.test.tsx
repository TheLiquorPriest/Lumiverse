import { expect, test } from 'bun:test'

// MessageContent exercises JSDOM globals and Bun module mocks. Keep the suite
// in a child process so focused frontend runs cannot inherit either seam.
test('MessageContent long-message cases pass in an isolated child process', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/components/chat/MessageContent.long-message.isolated.tsx',
  ], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const watchdog = setTimeout(() => {
    timedOut = true
    child.kill(9)
  }, 10_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const summary = `${stdout}\n${stderr}`
    if (timedOut) {
      throw new Error(`Isolated MessageContent long-message tests timed out:\n${summary}`)
    }
    if (exitCode !== 0) {
      throw new Error(`Isolated MessageContent long-message tests failed with exit code ${exitCode}:\n${summary}`)
    }
    expect(timedOut).toBe(false)
    expect(exitCode).toBe(0)
    expect(summary).toMatch(/\b3 pass\b/)
    expect(summary).toMatch(/\b0 fail\b/)
    expect(summary).toMatch(/\b[1-9]\d* expect\(\) calls\b/)
    expect(summary).toMatch(/Ran 3 tests across 1 file/)
  } finally {
    clearTimeout(watchdog)
  }
}, 15_000)
