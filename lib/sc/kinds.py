"""Session kinds: kinds/<name>.md, in the user kinds folder or the core's.

Kinds are looked up in two folders: the user kinds (util.user_kinds_dir(), under
sous chef's data home), then the core kinds (util.kinds_dir(), under the code
root). A user kind replaces a core kind of the same name as a whole file. When both
folders are the same (as when the data home is the code root) there is only the
core. Kind names are lowercase kebab-case; any other name is an unknown kind.

Each file starts with a small front matter block, then the instructions that go
into a session's brief:

  ---
  description: one line shown by `sc kinds`
  starts_waiting_on: owner | agent
  permissions: bypass       (optional; one of runtimes.PERMISSIONS)
  skill: build              (optional; the one skill the instructions tell the session to run)
  ---
  <instructions>

`starts_waiting_on: owner` means the session is ready for the owner (util.owner)
to attach as soon as it launches; `agent` means it works on its own and reports
back. The owner's name in lower case is accepted in place of `owner`.
`{{owner}}` in the description and instructions is filled with the owner's name.
`permissions` is the mode a session of this kind launches in when `sc spawn`
is not given `--permissions`; without it, runtimes.DEFAULT_PERMISSIONS.
`skill` is a bare skill name (no slash); `sc spawn` asks the runtime whether it is
available and refuses when it is definitely missing (ops.check_skill).
Run `sc kinds` for the kinds that exist; no list of them lives in code.
"""
import re

from . import runtimes, util

ALLOWED_WAITING = {"owner", "agent"}
NAME = re.compile(r"[a-z0-9][a-z0-9-]*")


def _folders() -> list:
    """(source, folder) pairs in lookup order: the user kinds, then the core. One entry if they are the same."""
    core, user = util.kinds_dir(), util.user_kinds_dir()
    if user.resolve() == core.resolve():
        return [("core", core)]
    return [("user", user), ("core", core)]


def _find(name: str):
    """(source, path, replaces_core) for a kind, or None."""
    if not NAME.fullmatch(name or ""):
        return None
    found = [(source, folder / f"{name}.md") for source, folder in _folders() if (folder / f"{name}.md").is_file()]
    if not found:
        return None
    source, path = found[0]
    return source, path, source == "user" and len(found) > 1


def parse(text: str):
    meta, body = {}, text
    if text.startswith("---\n"):
        head, sep, rest = text[4:].partition("\n---\n")
        if sep:
            body = rest
            for line in head.splitlines():
                k, _, v = line.partition(":")
                if k.strip():
                    meta[k.strip()] = v.strip()
    return meta, body.strip()


def load(name: str) -> dict:
    found = _find(name)
    if not found:
        raise util.SCError(f"unknown kind '{name}' (known: {', '.join(names())})")
    source, path, replaces_core = found
    meta, body = parse(path.read_text())
    waiting = meta.get("starts_waiting_on", "agent")
    try:
        owner = util.owner()
    except util.SCError:
        owner = None
    if owner and waiting.lower() == owner["lower"]:
        waiting = "owner"
    if waiting not in ALLOWED_WAITING:
        raise util.SCError(f"{path}: starts_waiting_on must be owner or agent, not '{waiting}'")
    permissions = meta.get("permissions") or None
    if permissions is not None and permissions not in runtimes.PERMISSIONS:
        raise util.SCError(f"{path}: permissions must be one of {', '.join(runtimes.PERMISSIONS)}, "
                           f"not '{permissions}'")
    skill = meta.get("skill") or None
    if skill is not None and (skill.startswith("/") or any(c.isspace() for c in skill)):
        raise util.SCError(f"{path}: skill must be a bare skill name such as build, not '{skill}'")
    # Without an owner (`sc kinds` still works then) the text says "the owner".
    description = util.render(meta.get("description", ""), {"owner": owner["name"] if owner else "the owner"})
    return {"name": name, "description": description, "starts_waiting_on": waiting,
            "permissions": permissions, "skill": skill, "body": body, "source": source, "replaces_core": replaces_core,
            "path": str(path)}


def names_skill(body: str, skill: str) -> bool:
    """Whether the instructions name the skill as /<skill>, as a whole name (so /shape-gui is not /shape)."""
    return re.search(rf"/{re.escape(skill)}(?![A-Za-z0-9_:-]|\.\w)", body) is not None


def separate_user_kinds() -> bool:
    """Whether there is a user kinds folder apart from the core's (see _folders)."""
    return len(_folders()) > 1


def names() -> list:
    """Every kind name in either folder, once each, sorted."""
    found = set()
    for _source, folder in _folders():
        found.update(p.stem for p in folder.glob("*.md") if NAME.fullmatch(p.stem))
    return sorted(found)
