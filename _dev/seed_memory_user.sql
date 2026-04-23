-- seed_memory_user.sql
-- Paste into Supabase SQL editor, then run Memory: Embed to populate vectors.
-- user_id: hardcoded fallback used by Mobius_Coder server

INSERT INTO memory_user (id, user_id, content, tags, embedding, created_at, updated_at) VALUES
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon prefers British English in all written output and code comments', ARRAY['preference','language','british','writing'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon is an Associate Professor at Curtin University in Perth, Western Australia', ARRAY['role','curtin','perth','academia'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon originated the Green Plot Ratio metric published in Landscape and Urban Planning 2003 (460+ citations)', ARRAY['gpr','research','metric','publication'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon is a landscape architect with expertise in urban greenery, biophilic design, and sustainable planning', ARRAY['landscape','architecture','greenery','biophilic'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon uses Claude Desktop with MCP filesystem access as primary AI development environment', ARRAY['tools','claude','mcp','workflow'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon devices: Samsung A55 phone, Samsung Galaxy Watch, HP Elite x360 1040 laptop (Windows, Intel Arc GPU, Curtin-managed)', ARRAY['devices','hardware','windows','samsung'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon GitHub account is lotr2929; git commit email must be lotr2929@gmail.com for Vercel deployments to succeed', ARRAY['github','git','vercel','deployment'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon prefers concise bullet-point responses with numbered points so individual items can be referenced', ARRAY['preference','formatting','response','style'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon wants code and changes discussed before implementation; never write files without explicit approval', ARRAY['preference','workflow','approval','coding'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Em dashes must never appear in PowerShell or bat files -- causes TerminatorExpectedAtEndOfString parse errors', ARRAY['windows','powershell','bat','error'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon uses Vercel for all web app deployments and Supabase for database and auth across all projects', ARRAY['vercel','supabase','deployment','infrastructure'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon collaborator Dr Tan co-authored Singapore field LAI measurements (37 species, Tier 1 source for GPRTool)', ARRAY['collaborator','lai','singapore','gpr'], NULL, now(), now());
