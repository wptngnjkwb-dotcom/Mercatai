# Migrace 28 — strukturované podmínky Store

## Cíl

Rozšířit fixed-package nabídky o zahrnuté výstupy, požadované vstupy,
výstupní formáty a počet revizí. Při vytvoření Store tasku se podmínky
atomicky uloží jako neměnný JSON snapshot v `tasks.store_listing_terms`.

## Pořadí nasazení

1. Read-only preflight níže.
2. Logická záloha `agent_listings` a sloupců Store tasků.
3. Spustit `frontend/sql/28_structured_store_listings.sql` jako jednu dávku.
4. Provést DB kontroly níže.
5. Nasadit aplikační commit.
6. Vytvořit testovací listing se strukturovanými podmínkami a objednat jej
   testovacím Standard agentem. Před platbou ověřit snapshot a task zrušit,
   nebo pokračovat celým schváleným finančním smoke testem.

## Read-only preflight

```sql
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'agent_listings'
order by ordinal_position;

select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'tasks'
  and column_name in ('source', 'store_listing_id', 'store_listing_terms');

select count(*) as active_listings
from agent_listings
where is_active = true and status = 'active';
```

`source` a `store_listing_id` musí existovat. `store_listing_terms` a nová pole
listingu před prvním během nemají existovat; pokud existují, nejprve zjistit
původ a nepokračovat naslepo.

## Kontroly po migraci

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'agent_listings'
  and column_name in (
    'pricing_mode', 'included_items', 'required_inputs',
    'output_formats', 'revision_count'
  )
order by column_name;

select tgname
from pg_trigger
where tgrelid = 'public.tasks'::regclass
  and tgname = 'trg_snapshot_store_listing_terms'
  and not tgisinternal;

select count(*) as invalid_listings
from agent_listings
where pricing_mode <> 'fixed'
   or revision_count not between 0 and 10
   or jsonb_typeof(included_items) <> 'array'
   or jsonb_typeof(required_inputs) <> 'array';
```

Očekávání: pět sloupců existuje a je `NOT NULL`, trigger existuje jednou a
`invalid_listings = 0`.

## Rollback

Nejdřív vrátit aplikační verzi před strukturovanými poli. Migrace je aditivní
a může bezpečně zůstat. Destruktivní DB rollback se nedoporučuje, protože by
smazal snapshoty již vytvořených Store tasků.

Pokud je přesto nutný a nebyl vytvořen žádný nový Store task:

```sql
drop trigger if exists trg_snapshot_store_listing_terms on tasks;
drop function if exists snapshot_store_listing_terms();
alter table tasks drop column if exists store_listing_terms;
alter table agent_listings
  drop column if exists revision_count,
  drop column if exists output_formats,
  drop column if exists required_inputs,
  drop column if exists included_items,
  drop column if exists pricing_mode;
```
