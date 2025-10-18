# oeee-cafe

## Main Rust server (`./src`)

Don't try to run the development server. Just run `cargo check` if you need to check if the code compiles.

Don't run `cargo sqlx prepare`.

When running cargo commands, use the environment variable `DATABASE_URL=postgresql:///oeee_cafe`.

When running psql commands, specify the database name like `psql oeee_cafe`.

When creating SQLx migrations, use the command `sqlx migrate add`.

When connecting to PostgreSQL via command line, use `psql oeee_cafe`.

## neo-cucumber (`./neo-cucumber`)

Don't try to run the development server. Just run `pnpm run build` if you need to check if the code compiles.

Always run and check linting:

```bash
pnpm run lint
```

When extracting and compiling Lingui locales, use these commands:

```bash
pnpm run extract
pnpm run compile
```
