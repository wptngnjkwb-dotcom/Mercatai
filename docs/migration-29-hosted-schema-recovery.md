# Migrace 29 — obnova historického hostovaného schématu

## Cíl

Deset tabulek a dvě pomocné RPC vznikly v hostované databázi před číslovanou
migrační řadou. Aplikace je používá, ale čerstvá/self-hosted instalace je
dosud nevytvořila. Migrace 29 obnovuje jejich produkční tvar:

- `api_clients`, `api_usage`,
- `oauth_apps`, `oauth_auth_codes`, `oauth_refresh_tokens`,
- `webhooks`, `webhook_deliveries`,
- `affiliate_earnings`, `agent_portfolio`, `reviews`,
- `increment_api_usage`, `increment_webhook_failures`.

Definice byly dne 2026-10-23 získány read-only dotazem z produkčního katalogu.
Neobsahují produkční řádky ani tajné hodnoty. Oproti historickému ACL jsou obě
interní RPC a tabulky v migraci explicitně omezené na `service_role`; aplikace
všechny tyto operace provádí právě touto rolí.

## Před nasazením

1. Ověřit, že produkce má všech deset tabulek a obě funkce.
2. Zkontrolovat, že `agent_id` v obou OAuth tabulkách je `uuid`.
3. Udělat logickou zálohu uvedených tabulek a uložit kontrolní součty.
4. Spustit plnou testovací sadu, TypeScript, build a kontrolu diffu/secrets.

## Aplikace

Spustit `frontend/sql/29_restore_hosted_legacy_schema.sql` jako jednu dávku.
Migrace je aditivní a opakovatelná. V produkci už tabulky existují, proto se
nemění jejich data; obnoví se RPC a nastaví fail-closed oprávnění.

## Kontroly po migraci

- existuje 10 tabulek a 2 funkce,
- všech 10 tabulek má zapnuté RLS,
- `anon` ani `authenticated` nemají oprávnění k tabulkám ani RPC,
- `service_role` má plný přístup k tabulkám a `EXECUTE` na RPC,
- unikátní omezení fungují pro `(client_id, year_month)`, OAuth client ID,
  refresh-token hash a jednu recenzi na task,
- opakované spuštění migrace projde beze změny dat.

## Rollback

Rollback aplikace není nutný: migrace obnovuje objekty, které stávající kód
již používá. V produkci tabulky nemažme ani nevracíme. Pokud by nová
oprávnění nečekaně zablokovala legitimního klienta, nejprve obnovit pouze
původní grant z katalogové zálohy; data a tabulky ponechat.

Na čerstvém testovacím prostředí lze migraci vrátit odstraněním obou funkcí
a deseti tabulek v opačném pořadí závislostí. Tento destruktivní postup se na
produkci nepoužívá.
