-- Deployment values are bound at runtime, never embedded in migrations.
CREATE TABLE allowed_email (
	email TEXT PRIMARY KEY,
	person_id TEXT REFERENCES user(id),
	added_by TEXT NOT NULL,
	added_at INTEGER NOT NULL,
	removed_at INTEGER
);
CREATE INDEX allowed_email_person_id ON allowed_email(person_id);

CREATE TABLE deployment_owner (
	singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
	user_id TEXT NOT NULL REFERENCES user(id),
	bound_at INTEGER NOT NULL
);

CREATE TABLE sign_in_audit (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	actor_user_id TEXT NOT NULL,
	request_id TEXT NOT NULL,
	phase TEXT NOT NULL,
	change_kind TEXT NOT NULL,
	target_id TEXT NOT NULL,
	at INTEGER NOT NULL
);
CREATE INDEX sign_in_audit_request_id ON sign_in_audit(request_id);
