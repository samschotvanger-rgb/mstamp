/**
 * Application-role provisioning.
 *
 * Migration 002 creates `mstamp_app` with `CREATE ROLE`, which defaults to **NOLOGIN**,
 * and sets no password. The test harness switches into that role with `SET ROLE`,
 * which needs no login - so every row-level-security test passed while a real client
 * could not authenticate as the role at all.
 *
 * Migration 005 grants `LOGIN`. This module supplies the other half: a password, taken
 * from the environment at release time rather than committed in a `.sql` file.
 *
 * Why this is not cosmetic: the app role is the only role for which RLS applies. A
 * deployment that connects as the owner bypasses every policy and still passes its
 * tests, because the tests switch roles explicitly.
 */

import { queryRows, withConnection, type DbPool } from './db/client.js'

/** The non-superuser role every tenant-isolation guarantee depends on. */
export const APP_ROLE = 'mstamp_app'

/**
 * Set the application role's password.
 *
 * `ALTER ROLE ... PASSWORD` does not accept a bind parameter, so the statement is
 * built by Postgres itself with `format('%L')` and then executed. Letting the server do
 * the literal quoting removes the one place in this codebase where a hand-escaped
 * string would be interpolated into SQL.
 *
 * @throws if the password is empty. A blank password on a login role is a
 * misconfiguration that would otherwise succeed quietly.
 */
export async function setAppRolePassword(pool: DbPool, password: string): Promise<void> {
  if (password === '') throw new Error('MSTAMP_APP_PASSWORD must not be empty')

  await withConnection(pool, async (connection) => {
    // The casts are required, not stylistic: `format()` takes variadic `any`
    // arguments, so without them Postgres cannot infer a type for $1/$2 and rejects
    // the statement with "could not determine data type of parameter".
    const rows = await queryRows<{ statement: string }>(
      connection,
      `SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS statement`,
      [APP_ROLE, password],
    )

    const statement = rows[0]?.statement
    if (statement === undefined) {
      throw new Error('could not build the ALTER ROLE statement')
    }

    await connection.query(statement)
  })
}
