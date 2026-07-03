// Camada de acesso ao banco (Postgres).
//
// - Producao (Render + Supabase): usa `pg` com a connection string em DATABASE_URL.
// - Local / desenvolvimento: usa PGlite (Postgres em processo, sem servidor),
//   persistido na pasta ./pgdata. Assim `npm start` funciona sem instalar nada.
//
// Ambos falam o MESMO Postgres, entao os comandos SQL sao identicos.
// A interface exposta e simples: db.query(text, params) -> { rows, rowCount }.

let queryImpl;

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX) || 5
  });
  pool.on('error', (err) => console.error('Erro no pool Postgres:', err.message));
  queryImpl = (text, params) => pool.query(text, params);
  console.log('Banco: Postgres (DATABASE_URL) conectado.');
} else {
  // Import tardio: em producao (com DATABASE_URL) o PGlite nem precisa estar instalado.
  const { PGlite } = require('@electric-sql/pglite');
  const client = new PGlite(process.env.PGLITE_DIR || './pgdata');
  queryImpl = async (text, params) => {
    const result = await client.query(text, params);
    return {
      rows: result.rows || [],
      rowCount: typeof result.affectedRows === 'number' ? result.affectedRows : (result.rows ? result.rows.length : 0)
    };
  };
  console.log(`Banco: PGlite local (${process.env.PGLITE_DIR || './pgdata'}).`);
}

module.exports = {
  query: (text, params) => queryImpl(text, params)
};
