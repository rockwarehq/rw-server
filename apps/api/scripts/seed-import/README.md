-- ==========================================================================
-- SQL SERVER LEGACY DATA EXTRACTION SCRIPT
-- ==========================================================================
--
-- PURPOSE
-- -------
-- This script extracts configuration data from the legacy SQL Server database
-- so it can be imported into the new PostgreSQL database via the seed importer.
--
-- HOW TO USE
-- ----------
-- 1. Open SQL Server Management Studio (SSMS) and connect to the legacy database.
-- 2. Set output to "Results to Text" (Ctrl+T) — NOT "Results to Grid".
--    This is critical because the importer (prisma/seed/import/utils.ts)
--    parses fixed-width text output. Grid output will not work.
-- 3. Run this entire script.
-- 4. Copy ALL output (including the "=== SectionName ===" markers and
--    the "// comment" lines) into: prisma/seed/data/sqlLegacyData.txt
-- 5. Run the importer:  pnpm tsx prisma/seed/import/index.ts
--
-- OUTPUT FORMAT
-- -------------
-- The importer expects:
--   - Section markers:  === SectionName ===
--   - Comment lines:    //some comment (these are skipped by the parser)
--   - Fixed-width table output: header row, dash separator, data rows
--   - Footer lines like "(N rows affected)" are ignored by the parser
--
-- The parser (parseFixedWidthSections in utils.ts) uses the dash separator
-- line to determine column boundaries, then slices each data row by position.
-- Column values of "NULL" are converted to empty strings (treated as null).
--
-- IMPORTER CONFIGURATION
-- ----------------------
-- Before running the import, set the target Site and Workspace in:
--   prisma/seed/import/config.ts
--
-- Currently configured as:
--   siteName:      "South Africa - Dixie"
--   workspaceName: "Default"
--
-- The importer resolves the Site by (siteName + workspaceName) and attaches
-- all imported records to that site's UUID in PostgreSQL.
--
-- IMPORT ORDER & DEPENDENCIES
-- ---------------------------
-- The importer runs in strict foreign-key dependency order (see index.ts):
--
--   1. ProcessType        (no dependencies — reference table)
--   2. Workcenter         (depends on: ProcessType)
--   3. Product            (no dependencies — has VERSION versioning)
--   4. Material           (no dependencies — has VERSION versioning)
--   5. ProductMaterial    (depends on: Product, Material)
--   6. Tool               (no dependencies — has VERSION versioning)
--   7. ToolCavities       (depends on: Tool — has VERSION versioning)
--   8. Job                (depends on: ProcessType, Tool — has VERSION versioning)
--      Also creates JobTool links for production jobs that share a name with a Tool
--   9. Station            (depends on: Workcenter, Job — has VERSION versioning)
--  10. JobCavity          (depends on: Job, Product, Tool, ToolCavity — has VERSION versioning)
--      (imported as "JobProduct" in the new schema)
--  11. StatusCategory     (no dependencies — reference table)
--  12. StatusReason       (depends on: StatusCategory, ProcessType)
--  13. ItemDisposition    (no dependencies — reference table)
--  14. ItemDispositionReason (depends on: ProcessType)
--  15. EmployeeRole       (no dependencies — reference table per site)
--  16. Employee           (depends on: EmployeeRole — uses EmployeeVersion snapshots)
--
-- VERSION VERSIONING PATTERN
-- -----------------------
-- Several Prisma models use a "version" versioning pattern:
--   - The main table (e.g., Product) holds a currentVersionId pointer.
--   - Each change creates a new version row with an incremented version number.
--   - The main table's currentVersionId is then updated to point at the new version.
--
-- On first import:  version version = 1
-- On re-import if data changed:  version version = max(existing versions) + 1
-- On re-import if data unchanged: no new version is created (idempotent)
--
-- Tables with version versioning:
--   Product      -> ProductVersion      (sku, name, weight, itemCost)
--   Material     -> MaterialVersion     (name, shortCode, materialNumber, description)
--   Tool         -> ToolVersion         (name, pmLimit, pmWarn)
--   ToolCavity   -> ToolCavityVersion   (name, position)
--   Job          -> JobVersion          (name, description, standardCycle)
--   Station      -> StationVersion      (standardCycle, downtimeDetect, slowDetect, inLineCalculations, processTypeId)
--   JobProduct   -> JobProductVersion   (isActive, quantity)
--
-- ID MAPPING (IdMap)
-- ------------------
-- SQL Server uses string-based IDs (names). PostgreSQL uses UUIDs.
-- The importer maintains an in-memory IdMap that maps:
--   oldName (string, case-insensitive) -> newUUID (string)
--
-- Each section below produces data that the importer will look up by name
-- to resolve foreign keys. The column aliases in each SELECT must match
-- the interface field names expected by the corresponding import*.ts file.
--
-- COLUMN ALIAS -> IMPORTER FIELD MAPPING
-- ---------------------------------------
-- Each query below aliases SQL Server columns to match the TypeScript interface
-- in the corresponding importer file. If you change an alias, you must also
-- update the matching interface in prisma/seed/import/import<Table>.ts.
--
-- ==========================================================================

-- --------------------------------------------------------------------------
-- GENERAL NOTES (printed into output for the importer to preserve)
-- --------------------------------------------------------------------------
print '//Some tables have a VERSION table tied to them. In this case if the row exists increment the version and insert a new entry. If the row doesnt exist use version 1. If the row was unchanged do nothing and leave as is'
print '//Site comes from /prisma/seed/import/config.ts'

-- ==========================================================================
-- 1. ProcessType
-- ==========================================================================
-- Prisma model:   ProcessType (in workcenter.prisma — referenced but defined elsewhere)
-- Importer:       prisma/seed/import/importProcessTypes.ts
-- SQL Server tbl: tblConfigProcess
-- IdMap key:       "processType" keyed by name
-- Prisma upsert:  unique constraint = (siteId, name)
--
-- Used by:  Workcenter.processTypeId, StationVersion.processTypeId, Job.processTypeId
--
-- Interface fields expected:
--   name:        string  -> ProcessName
--   Description: string  -> Description
-- --------------------------------------------------------------------------
print '=== ProcessType ==='
print '//For anything Process realted later it will have to use the name to link back and get the ID'
Select ProcessName as [name], [Description] from tblConfigProcess 

-- ==========================================================================
-- 2. Product
-- ==========================================================================
-- Prisma model:   Product + ProductVersion (inventory.prisma)
-- Importer:       prisma/seed/import/importProducts.ts
-- SQL Server tbl: tblConfigPN
-- IdMap key:       "product" keyed by Name (the PN column, NOT sku)
-- Lookup:         finds existing by (siteId, currentVersion.sku)
-- Version fields:    sku, name, weight, itemCost
--
-- Used by:  ProductMaterial.productId, JobProduct.productId
--
-- Interface fields expected:
--   sku:      string -> PartNumber  (used as ProductVersion.sku)
--   Name:     string -> PN          (used as ProductVersion.name AND the IdMap key)
--   weight:   string -> PartWeight  (parsed to number, stored as Decimal(14, 4))
--   itemCost: string -> PartCost    (parsed via parseDecimalCommaNumber — accepts
--                                    "12,34" European format — stored as Decimal(14, 4))
--
-- NOTE: The IdMap stores the mapping under the product Name (PN), not the sku.
--       So downstream queries (ProductMaterial, JobCavity) must reference by Name.
-- --------------------------------------------------------------------------
print '=== Product ==='
print '//For anything Part realted later it will have to use the name to link back and get the ID'
Select PartNumber as sku,PN as [Name],PartWeight as [weight],PartCost as [itemCost] from tblConfigPN 

-- ==========================================================================
-- 3. Material
-- ==========================================================================
-- Prisma model:   Material + MaterialVersion (inventory.prisma)
-- Importer:       prisma/seed/import/importMaterials.ts
-- SQL Server tbl: tblConfigMaterial
-- IdMap key:       "material" keyed by shortCode (MaterialID column)
-- Lookup:         finds existing by (siteId, currentVersion.shortCode)
-- Version fields:    name, shortCode, materialNumber, description, weightUnits, unitCost
--
-- Used by:  ProductMaterial.materialId
--
-- Interface fields expected:
--   name:           string -> MaterialDescription
--   shortCode:      string -> MaterialID   (used as the IdMap key)
--   materialNumber: string -> MaterialId   (falls back to shortCode if empty)
--   description:    string -> MaterialDescription
--   Unit:           string -> Unit         (mapped: gm/g->G, kg->KG, lb/lbs->LB, oz->OZ;
--                                            falls back to KG when NULL/unmapped)
--   UnitCost:       string -> UnitCost     (parsed to number; European comma format
--                                            "5,00" supported; falls back to 5 when NULL)
--
-- NOTE: materialNumber and shortCode both map from MaterialID here because
--       the legacy system only has one identifier. The importer uses
--       row.materialNumber || row.shortCode as the final materialNumber.
--       Unit and UnitCost are nullable in tblConfigMaterial — the importer
--       falls back to defaults when they're NULL.
-- --------------------------------------------------------------------------
print '=== Material ==='
print '//For anything Material realted later it will have to use the name to link back and get the ID'
SELECT MaterialDescription as [name],MaterialID as shortCode,MaterialId as materialNumber,MaterialDescription as [description],[Unit],[UnitCost] FROM tblConfigMaterial

-- ==========================================================================
-- 4. ProductMaterial
-- ==========================================================================
-- Prisma model:   ProductMaterial (inventory.prisma) — join table, no version
-- Importer:       prisma/seed/import/importProductMaterials.ts
-- SQL Server tbl: tblConfigPN_Material
-- IdMap key:       (none created — this is a link table)
-- Prisma upsert:  unique constraint = (productId, materialId)
--
-- Resolves FKs via IdMap:
--   product  -> idMap.get("product", row.product)    — matches Product Name (PN)
--   material -> idMap.get("material", row.material)  — matches Material shortCode
--
-- Interface fields expected:
--   product:     string -> PN           (product Name for IdMap lookup)
--   material:    string -> materialID   (material shortCode for IdMap lookup)
--   weight:      string -> weight       (parsed to number; European comma format "12,37" supported)
--   weightUnits: string -> unit         (mapped: gm/g->G, kg->KG, lb->LB, oz->OZ)
--
-- NOTE: A product can have multiple materials (many-to-many). The same product
--       name may appear on multiple rows with different material shortCodes.
-- --------------------------------------------------------------------------
print '=== ProductMaterial ==='
print '//Use names from other tables to get the IDs'
SELECt PN as [product],materialID as material, [weight],[unit] as weightUnits FROM tblConfigPN_Material


-- ==========================================================================
-- 5. Workcenter
-- ==========================================================================
-- Prisma model:   Workcenter (workcenter.prisma) — no version versioning
-- Importer:       prisma/seed/import/importWorkcenters.ts
-- SQL Server tbl: tblConfigLine
-- IdMap key:       "workcenter" keyed by PXID (the line identifier in
--                  tblConfigLine; tblConfigSN1.PXID is the FK back to it)
-- Lookup:         findFirst by (siteId, parentId=null, name)
--                 Cannot use upsert because parentId is nullable in the
--                 composite unique @@unique([siteId, parentId, name])
--
-- Resolves FKs via IdMap:
--   GroupID -> idMap.get("processType", row.GroupID)
--
-- Used by:  Station.workcenterId (joined via PXID)
--
-- Interface fields expected:
--   PXID:        string -> PXID         (line identifier, used as IdMap key)
--   name:        string -> Title1
--   GroupID:     string -> GroupID      (processType name for IdMap lookup)
--   Description: string -> Description
-- --------------------------------------------------------------------------
print '=== Workcenter ==='
print '//For anything Workcenter realted later it will have to use the name to link back and get the ID'
Select PXID,Title1 as [name],Process,Description from tblConfigLine 

-- ==========================================================================
-- 6. Station
-- ==========================================================================
-- Prisma model:   Station + StationVersion (workcenter.prisma)
-- Importer:       prisma/seed/import/importStations.ts
-- SQL Server tbl: tblConfigSN1
-- IdMap key:       "station" keyed by name (SN1)
-- Prisma upsert:  unique constraint = (siteId, name)
-- Version fields:    standardCycle, downtimeDetect, slowDetect, inLineCalculations, processTypeId
--
-- Resolves FKs via IdMap:
--   PXID        -> idMap.get("workcenter", row.PXID)    — workcenter linkage
--   currentJob  -> idMap.get("job", row.currentJob)     — if not found, set to null
--   ProcessType -> idMap.get("processType", row.ProcessType) — stored in StationVersion
--
-- Station-level fields (on Station table, NOT in version):
--   name, workcenterId, currentJobId
--
-- StationVersion fields (versioned):
--   standardCycle, downtimeDetect, slowDetect, inLineCalculations, processTypeId
--
-- Interface fields expected:
--   PXID:               string -> PXID              (workcenter line ID for IdMap lookup)
--   name:               string -> SN1
--   standardCycle:      string -> StdCt             (parsed to number, stored as Decimal)
--   currentJob:         string -> JobID_Current     (job name for IdMap lookup)
--   slowDetect:         string -> SlowPercent       (European comma format supported, stored as Decimal)
--   downtimeDetect:     string -> DTSeconds         (parsed to number, stored as Decimal)
--   inLineCalculations: string -> ABS(LineCalculation) (coerced to boolean: "1"=true)
--   ProcessType:        string -> ProcessName       (processType name for IdMap lookup)
-- --------------------------------------------------------------------------
print '=== Station ==='
print '//For anything Station realted later it will have to use the name to link back and get the ID'
Select PXID,SN1 as [name],StdCt as standardCycle,JobID_Current as currentJob,SlowPercent as slowDetect,DTSeconds as downtimeDetect,ABS(LineCalculation) as inLineCalculations, ProcessName as ProcessType from tblConfigSN1


-- ==========================================================================
-- 7. Tool
-- ==========================================================================
-- Prisma model:   Tool + ToolVersion (job.prisma)
-- Importer:       prisma/seed/import/importTools.ts
-- SQL Server tbl: tblConfigTool
-- IdMap key:       "tool" keyed by Name (ToolId)
-- Lookup:         finds existing by (siteId, currentVersion.name)
-- Version fields:    name, pmLimit, pmWarn
-- Non-version fields on Tool table: pmCount (updated even if version unchanged)
--
-- Used by:  ToolCavity.toolId, JobTool.toolId, JobProduct.toolId
--
-- Interface fields expected:
--   Name:    string -> ToolId     (used as ToolVersion.name AND the IdMap key)
--   pmLimit: string -> PM_Limit   (parsed to int, stored in ToolVersion)
--   pmWarn:  string -> PM_Warning (parsed to int, stored in ToolVersion)
--   pmCount: string -> PM_Count   (parsed to int, stored on Tool table directly)
-- --------------------------------------------------------------------------
print '=== Tool ==='
print '//For anything Tool realted later it will have to use the name to link back and get the ID'
Select ToolId as  [Name],PM_Limit as pmLimit, PM_Warning as pmWarn, PM_Count as pmCount from tblConfigTool 

-- ==========================================================================
-- 8. ToolCavities
-- ==========================================================================
-- Prisma model:   ToolCavity + ToolCavityVersion (job.prisma)
-- Importer:       prisma/seed/import/importToolCavities.ts
-- SQL Server tbl: tblConfigJob_Cavity (DISTINCT ToolId, CavityID only)
-- IdMap key:       "toolCavity" keyed by composite "TOOLNAME:CAVITYID"
-- Lookup:         finds existing by (toolId, currentVersion.name = cavityName)
-- Version fields:    name (=CavityID), position (=parseInt(CavityID))
--
-- Resolves FKs via IdMap:
--   toolId -> idMap.get("tool", row.ToolId)
--
-- Used by:  JobProduct.toolCavityId
--
-- Interface fields expected:
--   ToolId:   string -> ToolId     (tool name for IdMap lookup)
--   CavityID: string -> CavityID   (used as ToolCavityVersion.name; parsed to int for position)
--
-- NOTE: We use SELECT DISTINCT because tblConfigJob_Cavity has one row per
--       (Job, Tool, Cavity, Product) combination, but we only need the unique
--       (Tool, Cavity) pairs to create ToolCavity records.
-- --------------------------------------------------------------------------
print '=== ToolCavities ==='
Select distinct ToolId,CavityID from tblConfigJob_Cavity 

-- ==========================================================================
-- 9. Job
-- ==========================================================================
-- Prisma model:   Job + JobVersion (job.prisma)
-- Importer:       prisma/seed/import/importJobs.ts
-- SQL Server tbl: tblConfigJob
-- IdMap key:       "job" keyed by name (JobId)
-- Lookup:         finds existing by (siteId, currentVersion.name, deletedAt=null)
-- Version fields:    name, description, standardCycle
-- Non-version:       processTypeId (hard-coded to "MOLD" in importer)
--
-- The importer also creates JobTool records:
--   For each production job (not in ["MAINT","OPEN","SCHED DOWN","TOOLING"]),
--   if a Tool exists with the same name, a JobTool link is created.
--   This works because in the legacy system, job names = tool names for production jobs.
--
-- Used by:  Station.currentJobId, JobProduct.jobId, JobTool.jobId
--
-- Interface fields expected:
--   name:              string -> JobId            (used as JobVersion.name AND the IdMap key)
--   description:       string -> JobDescription
--   standardCycle:     string -> StdCT            (parsed to number, stored as Decimal)
--   standardCycleUnit: string -> literal 'SECONDS' (hardcoded in query — matches Prisma enum)
--
-- NOTE: Non-production jobs (MAINT, OPEN, SCHED DOWN, TOOLING) have
--       standardCycle = 0 and no corresponding Tool. The importer skips
--       JobTool creation for these.
-- --------------------------------------------------------------------------
print '=== Job ==='
print '//For anything Job realted later it will have to use the name to link back and get the ID'
Select JobId as name, JobDescription as [description], StdCT as [standardCycle],'SECONDS' as standardCycleUnit from tblConfigJob

-- ==========================================================================
-- 10. JobCavity (imported as "JobProduct" in the new schema)
-- ==========================================================================
-- Prisma model:   JobProduct + JobProductVersion (job.prisma)
-- Importer:       prisma/seed/import/importJobProducts.ts
-- SQL Server tbl: tblConfigJob_Cavity
-- IdMap key:       (none created — this is a link/assignment table)
-- Lookup:         findFirst by (jobId, productId, toolId, toolCavityId) for idempotency
-- Version fields:    isActive, quantity (quantity is always 1)
--
-- Resolves FKs via IdMap:
--   jobId        -> idMap.get("job", row.JobName)
--   productId    -> idMap.get("product", row.ProductName)     — NOTE: by product Name, not sku
--   toolId       -> idMap.get("tool", row.ToolName)           — optional, null if not found
--   toolCavityId -> idMap.get("toolCavity", "TOOLNAME:CAVITYNAME") — optional, null if not found
--
-- Interface fields expected:
--   JobName:     string -> JobID    (job name for IdMap lookup)
--   ToolName:    string -> ToolID   (tool name for IdMap lookup)
--   CavityName:  string -> CavityID (combined with ToolName for toolCavity IdMap lookup)
--   ProductName: string -> PN       (product Name for IdMap lookup — must match Product.Name)
--   Active:      string -> ABS(Active)  (coerced to boolean: "1"=true, "0"=false)
--
-- NOTE: The section name in the output is "JobCavity" but the importer reads
--       it as readData("JobCavity") and imports it into the JobProduct model.
--       This preserves the legacy naming while mapping to the new schema.
-- --------------------------------------------------------------------------
print '=== JobCavity ==='
Select JobID as JobName, ToolID as ToolName, CavityID as CavityName,PN as ProductName,ABS(Active) as Active from tblConfigJob_Cavity

-- ==========================================================================
-- 11. StatusCategory
-- ==========================================================================
-- Prisma model:   StatusCategory (workspace.prisma) — no version versioning
-- Importer:       prisma/seed/import/importStatusCategories.ts
-- SQL Server tbl: tblConfigFTType
-- IdMap key:       "statusCategory" keyed by name (FTTypeID)
-- Prisma upsert:  unique constraint = (siteId, name)
--
-- Used by:  StatusReason.categoryId
--
-- Interface fields expected:
--   name:     string -> FTTypeID
--   isActive: string -> ABS(active)  (not stored in Prisma — retained for reference)
--
-- NOTE: The isActive field is in the SQL output for reference but is not
--       currently mapped to a Prisma field. Categories are all imported.
-- --------------------------------------------------------------------------
print '=== StatusCategory ==='
print '//For anything Status Category realted later it will have to use the name to link back and get the ID'
select FTTypeID as [name], ABS(active) as isActive from tblConfigFTType

-- ==========================================================================
-- 12. StatusReason
-- ==========================================================================
-- Prisma model:   StatusReason (workspace.prisma) — no version versioning
-- Importer:       prisma/seed/import/importStatusReasons.ts
-- SQL Server tbl: tblConfigDT
-- IdMap key:       "statusReason" keyed by name (FN)
-- Prisma upsert:  unique constraint = (siteId, name)
--
-- Resolves FKs via IdMap:
--   categoryId   -> idMap.get("statusCategory", row.statusCategoryName)
--   processTypes -> idMap.get("processType", row.DTGroupID)  (implicit m2m)
--
-- Used by:  StationStateLog.statusReasonId
--
-- Interface fields expected:
--   DTGroupID:          string -> DTGroupID          (process type name for m2m link)
--   name:               string -> FN                 (status reason display name)
--   statusCategoryName: string -> FTTypeID           (status category name for IdMap lookup)
--   isPlannedDown:      string -> 1 - ABS([DT])      (coerced to boolean: "1"=planned down)
-- --------------------------------------------------------------------------
print '=== StatusReason ==='
select DTGroupID,FN as [name],FTTypeID as statusCategoryName, 1 - ABS([DT]) AS isPlannedDown from tblConfigDT

-- ==========================================================================
-- 13. ItemDisposition
-- ==========================================================================
-- Prisma model:   ItemDisposition (inventory.prisma) — no version versioning
-- Importer:       prisma/seed/import/importItemDispositions.ts
-- SQL Server tbl: (hardcoded — only "SCRAP" disposition exists currently)
-- IdMap key:       "itemDisposition" keyed by name
-- Prisma upsert:  unique constraint = (siteId, name)
--
-- Used by:  ItemDispositionReason.itemDispositionId
--
-- Interface fields expected:
--   name: string -> literal 'SCRAP'
--
-- NOTE: The legacy system only has one disposition type ("SCRAP").
--       Additional disposition types can be added by extending this query.
-- --------------------------------------------------------------------------
print '=== ItemDisposition ==='
select 'SCRAP' as [name]

-- ==========================================================================
-- 14. ItemDispositionReason
-- ==========================================================================
-- Prisma model:   ItemDispositionReason (inventory.prisma) — no version versioning
-- Importer:       prisma/seed/import/importItemDispositionReasons.ts
-- SQL Server tbl: tblConfigRC
-- IdMap key:       "itemDispositionReason" keyed by name (RC)
-- Prisma upsert:  unique constraint = (siteId, name)
--
-- Resolves FKs via IdMap:
--   processTypeId -> idMap.get("processType", row.ProcessName)
--
-- Used by:  ItemDispositionLog.dispositionReasonId
--
-- Interface fields expected:
--   ProcessName: string -> ProcessName  (process type name for IdMap lookup)
--   name:        string -> RC           (reason display name)
--   isActive:    string -> ABS(active)  (not stored in Prisma — retained for reference)
--
-- NOTE: The isActive field is in the SQL output for reference but is not
--       currently mapped to a Prisma field. All reasons are imported.
-- --------------------------------------------------------------------------
print '=== ItemDispositionReason ==='
Select ProcessName, RC as [name], ABS(active) as isActive from tblConfigRC

-- ==========================================================================
-- 15. EmployeeRole
-- ==========================================================================
-- Prisma model:   EmployeeRole (employee.prisma) — no version pattern
-- Importer:       prisma/seed/import/importEmployeeRoles.ts (planned)
-- SQL Server tbl: sysNameType
-- IdMap key:       "employeeRole" keyed by name (NameTypeID)
-- Prisma upsert:  unique constraint = (siteId, name)
--
-- The site is resolved from prisma/seed/import/config.ts. The importdev path
-- pre-seeds 8 default roles (Operator, Supervisor, Lead, Quality, Maintenance,
-- Contractor, Engineer, Manager). Legacy role names that collide with these
-- reuse the existing row via upsert; new names create new rows.
--
-- Used by:  EmployeeSiteAccess.roleId
--
-- Interface fields expected:
--   name: string -> NameTypeID
-- --------------------------------------------------------------------------
print '=== EmployeeRole ==='
print '//Roles are upserted per site by name. Legacy names that match the seeded defaults are reused.'
select NameTypeID as [name] from sysNameType

-- ==========================================================================
-- 16. Employee
-- ==========================================================================
-- Prisma model:   Employee + EmployeeVersion + EmployeeSiteAccess (employee.prisma)
-- Importer:       prisma/seed/import/importEmployees.ts (planned)
-- SQL Server tbl: [System].dbo.[sysName]
-- IdMap key:       "employee" keyed by NameID (case-insensitive)
-- Lookup:          finds existing Employee via IdMap; if the profile changed,
--                  a new EmployeeVersion is created (version = max + 1) and
--                  Employee.versionId is updated. Same version pattern as the
--                  models above.
--
-- Resolves FKs via IdMap:
--   roleId      -> idMap.get("employeeRole", row.Role)
--                  If not found, falls back to "Operator". If "Operator" is
--                  also missing, the EmployeeSiteAccess row is skipped and a
--                  warning is logged — the Employee + Version are still
--                  created so the person is not lost.
--   workspaceId -> resolved from config.workspaceName
--   siteId      -> resolved from config.siteName (used for EmployeeSiteAccess)
--
-- Employee table fields (non-versioned):
--   workspaceId, status (always ACTIVE on import — legacy has no exposed
--   per-row active flag in this query)
--
-- EmployeeVersion fields (versioned profile snapshot):
--   firstName       -> NameID, characters before the first space
--   lastName        -> NameID, characters after the first space; "" if no space
--   employeeNumber  -> EmployeeID; null if blank or "NULL"
--   pinHash         -> bcrypt(PIN) via hashPassword(); null if blank or "NULL"
--   badgeNumber     -> not in source; left null
--
-- EmployeeSiteAccess fields:
--   employeeId, siteId, roleId (with Operator fallback), status = ACTIVE
--
-- Interface fields expected:
--   NameID:     string -> NameID        (full legacy name; split in importer)
--   Role:       string -> NameTypeId    (employeeRole name for IdMap lookup)
--   PIN:        string -> [Password]    (plaintext; hashed via hashPassword on import)
--   EmployeeID: string -> [Number]      (legacy employee number; nullable)
--
-- NOTES:
--   - lastName is NOT NULL in the schema. Employees whose NameID has no space
--     get lastName = "" and the UI is expected to render firstName alone when
--     lastName is empty.
--   - PIN is treated as plaintext on import and bcrypt-hashed via
--     src/services/auth/session.ts hashPassword() (cost 10), matching the
--     live create path in src/services/employee/crud.ts.
--   - employeeNumber is nullable. Operators with no number cannot use the
--     EMPLOYEE_ID logon path, but the PIN, BADGE, and GENERIC logon paths
--     still work.
-- --------------------------------------------------------------------------
print '=== Employee ==='
print '//NameID is split on the first space into firstName/lastName. Empty lastName is allowed.'
print '//PIN (Password) is plaintext in the source and is bcrypt-hashed by the importer.'
print '//EmployeeID (Number) and PIN may be NULL — the importer stores null in those cases.'
print '//Role with no matching EmployeeRole falls back to "Operator"; if that is missing too, no site access is created.'
select NameID, NameTypeId as Role, [Password] as PIN, [Number] as EmployeeID from [System].dbo.[sysName]

-- ==========================================================================
-- SQL SERVER SOURCE TABLE REFERENCE
-- ==========================================================================
-- Legacy table            -> New Prisma model(s)          -> Data file section
-- ----------------------     ---------------------------     -----------------
-- tblConfigProcess        -> ProcessType                  -> ProcessType
-- tblConfigPN             -> Product, ProductVersion         -> Product
-- tblConfigMaterial       -> Material, MaterialVersion       -> Material
-- tblConfigPN_Material    -> ProductMaterial               -> ProductMaterial
-- tblConfigLine           -> Workcenter                   -> Workcenter
-- tblConfigSN1            -> Station, StationVersion         -> Station
-- tblConfigTool           -> Tool, ToolVersion               -> Tool
-- tblConfigJob_Cavity     -> ToolCavity, ToolCavityVersion   -> ToolCavities (DISTINCT)
-- tblConfigJob            -> Job, JobVersion, JobTool        -> Job
-- tblConfigJob_Cavity     -> JobProduct, JobProductVersion   -> JobCavity (full rows)
-- tblConfigFTType         -> StatusCategory               -> StatusCategory
-- tblConfigDT             -> StatusReason                  -> StatusReason
-- (hardcoded)             -> ItemDisposition               -> ItemDisposition
-- tblConfigRC             -> ItemDispositionReason         -> ItemDispositionReason
-- sysNameType             -> EmployeeRole                  -> EmployeeRole
-- [System].dbo.[sysName]  -> Employee, EmployeeVersion,
--                            EmployeeSiteAccess            -> Employee
-- ==========================================================================