-- seed_memory_project.sql
-- Paste into Supabase SQL editor, then run Memory: Embed to populate vectors.
-- project_ids can contain multiple project names where a fact spans projects.

INSERT INTO memory_project (id, user_id, content, tags, project_ids, file_refs, embedding, created_at, updated_at) VALUES

  -- GPRTool
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool is a Three.js PWA for calculating Green Plot Ratio of urban development sites', ARRAY['gpr','threejs','pwa','urban'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool domain: gprtool.vercel.app; GitHub: lotr2929/GPRTool; local path: C:\Users\263350F\_myProjects\GPRTool', ARRAY['gpr','url','github','path'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool uses Z-up coordinate system: X=East (Red), Y=North (Green), Z=Up (Blue) -- matches AutoCAD and ArchiCAD', ARRAY['coordinates','zup','threejs','cad'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool north compass: designNorthAngle drives grid and housing layout; globalNorthAngle reserved for future import alignment', ARRAY['compass','north','design','angle'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool N needle points True North; green arrow points Design North', ARRAY['compass','north','needle','arrow'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool primary demo site: 30 Beaufort Street Perth WA 6000 (Northbridge Centre)', ARRAY['demo','site','perth','northbridge'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool GPR target tiers for Northbridge: Minimum 1.5, Optimum 3.5-4.5, Maximum 6.0+', ARRAY['gpr','targets','tiers','northbridge'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool LAI database: Singapore field data 37 species (Boon and Dr Tan) is Tier 1 primary source; ORNL/TRY values are open-ground and need urban calibration', ARRAY['lai','database','singapore','tier1'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool _design.md is the coordinate system authority document; update it when coordinate decisions change', ARRAY['design','coordinates','authority','document'], ARRAY['GPRTool'], ARRAY['_design.md'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool planned feature: Import by Address queries Landgate SLIP ArcGIS REST API to load cadastral parcel polygon', ARRAY['feature','import','landgate','cadastral'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool plant placement engine uses circle placement for trees/shrubs/bamboo and polygon for groundcover', ARRAY['plants','placement','circles','polygon'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool SketchUp workflow: SketchUp Free export to STL via imagetostl.com then convert to GLB for import', ARRAY['sketchup','stl','glb','import'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool unit auto-detection: values over 500 assumed millimetres and scaled by 0.001 to metres', ARRAY['units','mm','scale','import'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool commercialisation planned through GPRI (Green Plot Ratio Institute) as Pty Ltd with global franchise model', ARRAY['gpri','commercial','franchise','strategy'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),

  -- Mobius_Vercel
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Vercel is the main general-purpose Mobius app with Google OAuth, Dropbox, Supabase conversation logging', ARRAY['mobius','vercel','oauth','dropbox'], ARRAY['Mobius_Vercel'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Vercel has complexity-based AI routing via scoreComplexity() and self-test framework in self_test.js', ARRAY['routing','complexity','self-test','ai'], ARRAY['Mobius_Vercel'], ARRAY[]::text[], NULL, now(), now()),

  -- Shared across projects
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'All Mobius apps deploy via deploy.bat which creates a backup zip, bumps service-worker version, auto-generates commit message, and polls Vercel API for build status', ARRAY['deploy','bat','vercel','workflow'], ARRAY['GPRTool','Mobius_Coder','Mobius_Vercel'], ARRAY['deploy.bat'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'All projects use myProjectIDs.md for project IDs, paths, API key names, and URLs', ARRAY['reference','ids','paths','keys'], ARRAY['GPRTool','Mobius_Coder','Mobius_Vercel'], ARRAY['myProjectIDs.md'], NULL, now(), now());
