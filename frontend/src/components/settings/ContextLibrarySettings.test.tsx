import { expect, test } from 'bun:test'

// This settings fixture installs focused store/API module mocks. Keep the
// complete UI test in a child process so those mocks cannot replace modules in
// the shared frontend test runner.
test('context library settings cases pass in an isolated module graph', async () => {
  const child = Bun.spawn([
    process.execPath,
    'test',
    './src/components/settings/ContextLibrarySettings.isolated.tsx',
  ], {
    cwd: `${import.meta.dir}/../../..`,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const watchdog = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 10_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(watchdog)
  const summary = `${stdout}\n${stderr}`
  if (exitCode !== 0) {
    throw new Error(`Isolated context library settings tests failed:\n${summary}`)
  }
  expect(timedOut).toBe(false)
  expect(exitCode).toBe(0)
  expect(summary).toMatch(/\b7 pass\b/)
  expect(summary).toMatch(/\b0 fail\b/)
  expect(summary).toMatch(/\b[1-9]\d* expect\(\) calls\b/)
  expect(summary).toMatch(/Ran 7 tests across 1 file/)
}, 15_000)
