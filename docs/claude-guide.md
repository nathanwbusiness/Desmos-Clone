# Claude's guide to editing workspace graphs

Graphs live in the Supabase project **Vibes** (`ymcexpnjrciuykvhmkbf`), schema `desmos`. Use the Supabase connector's `execute_sql`. Every write through the helper functions below records Claude as the author, bumps the version, keeps the old version, and reaches Nathan's open tab within about 2 seconds.

## Read

```sql
-- what's there
select id, name, version, updated_by, note, bridge_status, updated_at
from desmos.graphs order by updated_at desc;

-- one graph's expressions, in order
select e.ord, e.x ->> 'id' as id, e.x ->> 'type' as type, e.x ->> 'latex' as latex, e.x ->> 'text' as text
from desmos.graphs g, jsonb_array_elements(g.state -> 'expressions' -> 'list') with ordinality e(x, ord)
where g.id = '<graph id>' order by e.ord;

-- settings and viewport
select state -> 'graph' from desmos.graphs where id = '<graph id>';
```

## Write (always with a short note that starts with "Claude:")

```sql
-- add a new line at the end (or after an existing id with the 4th argument)
select desmos.claude_put_expression('<graph id>',
  '{"type":"expression","id":"c1","latex":"y=a\\sin(bx)","color":"#c74440"}',
  'Claude: added a sine wave', null);

-- change a line: send the whole expression object with the same id
select desmos.claude_put_expression('<graph id>',
  '{"type":"expression","id":"c1","latex":"y=2a\\sin(bx)","color":"#c74440"}',
  'Claude: doubled the amplitude');

-- remove a line
select desmos.claude_remove_expression('<graph id>', 'c1', 'Claude: removed the sine wave');

-- replace the whole state (settings, folders, many lines at once)
select desmos.claude_set_state('<graph id>', '<full state json>'::jsonb, 'Claude: reorganized into folders');

-- start a new graph; Nathan opens it from the panel's Graphs list
select desmos.claude_new_graph('Pendulum',
  '{"version":11,"graph":{"viewport":{"xmin":-10,"ymin":-10,"xmax":10,"ymax":10}},"expressions":{"list":[]}}',
  'Claude: started a pendulum graph');

-- undo something: put an older version back
select version, updated_by, note, created_at from desmos.graph_versions where graph_id = '<graph id>' order by version desc;
select desmos.restore_version('<graph id>', <version>, 'claude');
```

## Rules for safe edits

- **Edit only what was asked.** Read the current state first; never rebuild a graph from memory.
- **Keep existing ids.** Desmos and the bridge match lines by `id`. New lines need a new, unique id (use a prefix like `c1`, `c2` so they never collide with Desmos's numeric ids).
- **Copy the shape of existing objects.** When changing a line, start from its current JSON and change fields; keep `color`, `folderId`, `slider` etc.
- **Escape backslashes for SQL + JSON:** a LaTeX `\sin` is written `\\sin` inside the JSON string literal in SQL (standard_conforming_strings is on, so SQL itself adds no extra escaping).
- **Common fields:** `type` (`expression`, `text`, `folder`, `table`, `image`), `latex`, `color` (hex), `hidden`, `folderId`, `lineStyle` (`SOLID`/`DASHED`/`DOTTED`), `pointStyle`, `fillOpacity`, `slider` (`{"hardMin":true,"hardMax":true,"min":"0","max":"10","step":"0.1"}`), `text` for notes. A slider is just an expression like `a=1` plus a `slider` object.
- **Check that it loaded:** after a write, `bridge_status` becomes `applied v<N>` once Nathan's open tab takes it, or `rejected v<N>: <reason>` if Desmos refused the state. On a rejection, fix it or restore the previous version. No status change means no tab is open right now; the change applies the next time Nathan opens the graph.
- **Deletes need Nathan.** The Supabase connector's approval prompt never reaches him, so DELETE/DROP statements time out. Prefer helpers above; for a real delete, give him a SQL snippet for the SQL editor.
- **Never read or print `desmos.bridge_keys`** beyond labels.
