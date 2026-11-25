-- Project roles (#58, docs/API.md → Projects → Roles). The creator (`projects.owner_id`) becomes
-- a member with role `owner`, existing members become `editor`. From now on
-- `project_members.role` alone decides access; `owner_id` only records who created the project.
ALTER TABLE project_members ADD COLUMN role TEXT NOT NULL DEFAULT 'editor'
    CHECK (role IN ('owner', 'editor', 'commenter', 'viewer'));

INSERT INTO project_members (project_id, user_id, role)
    SELECT id, owner_id, 'owner' FROM projects WHERE true
    ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'owner';
