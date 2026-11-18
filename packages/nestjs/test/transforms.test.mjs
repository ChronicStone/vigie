import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addModule, addRegister, setEnv } from '../build/cli/init.js'

const fresh = `import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
`

test('adds the module to an empty imports array, after the last import', () => {
  const out = addModule(fresh)
  assert.match(out, /import \{ AppService \} from '\.\/app\.service';\nimport \{ VigieModule \} from '@vigie\/nestjs';\n/)
  assert.match(out, /imports: \[VigieModule\.forRoot\(\)\]/)
})

test('prepends to existing imports and keeps them', () => {
  const out = addModule(fresh.replace('imports: []', 'imports: [ConfigModule.forRoot()]'))
  assert.match(out, /imports: \[VigieModule\.forRoot\(\), ConfigModule\.forRoot\(\)\]/)
})

test('creates imports when the module has none, and runs once', () => {
  const out = addModule(fresh.replace('  imports: [],\n', ''))
  assert.match(out, /@Module\(\{\n  imports: \[VigieModule\.forRoot\(\)\],/)
  assert.equal(addModule(out), out)
})

test('register goes first, once', () => {
  const out = addRegister("import { NestFactory } from '@nestjs/core';\n")
  assert.ok(out.startsWith("import '@vigie/nestjs/register';\n"))
  assert.equal(addRegister(out), out)
})

test('env lines are replaced, not duplicated', () => {
  const once = setEnv('PORT=3000', 'VIGIE_URL', 'http://a')
  assert.equal(setEnv(once, 'VIGIE_URL', 'http://b'), 'PORT=3000\nVIGIE_URL=http://b\n')
})

test('throws instead of guessing when imports is not an array', () => {
  assert.throws(() => addModule(fresh.replace('imports: []', 'imports: sharedImports')), /not an array literal/)
})

test('a commented-out imports line is left alone', () => {
  const src = fresh.replace('  imports: [],\n', '  // imports: [OldModule],\n')
  const out = addModule(src)
  assert.match(out, /\/\/ imports: \[OldModule\]/)
  assert.match(out, /@Module\(\{\n  imports: \[VigieModule\.forRoot\(\)\],/)
})

test('an imports key outside @Module is not touched', () => {
  const src = fresh.replace('  imports: [],\n', '') + '\nexport const other = { imports: [] }\n'
  const out = addModule(src)
  assert.match(out, /export const other = \{ imports: \[\] \}/)
  assert.match(out, /@Module\(\{\n  imports: \[VigieModule\.forRoot\(\)\],/)
})

test('nested imports inside another module call are not the top-level one', () => {
  const src = fresh.replace('imports: []', 'imports: [TypeOrmModule.forRootAsync({ imports: [ConfigModule] })]')
  const out = addModule(src)
  assert.match(out, /imports: \[VigieModule\.forRoot\(\), TypeOrmModule\.forRootAsync\(\{ imports: \[ConfigModule\] \}\)\]/)
})
