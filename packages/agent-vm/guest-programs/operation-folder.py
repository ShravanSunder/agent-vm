"""Fixed application file operations, invoked by the controller inside a VM.

This is not Gondolin's sandboxd helper and changes no Gondolin protocol. The
controller supplies the authorized root; agent-facing APIs never accept it.
"""

import errno
import hashlib
import json
import os
import shutil
import stat
import sys
import typing as t
from contextlib import contextmanager

FILE_LIMIT = 16 * 1024 * 1024
TOTAL_LIMIT = 64 * 1024 * 1024
LIST_LIMIT = 256
METADATA_LIMIT = 32 * 1024
INVENTORY_LIMIT = 4096
PATH_DEPTH_LIMIT = 32
NAME_BYTE_LIMIT = 255
ASCII_CONTROL_LIMIT = 32
ASCII_DELETE = 127
SHA256_HEX_LENGTH = 64
PUBLISH_EXTRA_ARGUMENTS = 3
REQUIRED_ARGUMENTS = 4
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class FileOperationError(Exception):
    def __init__(self, code: int) -> None:
        super().__init__("operation file request failed")
        self.code = code


def components(value: str, *, allow_empty: bool = False) -> list[str]:
    if allow_empty and not value:
        return []
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts) or any(
        ord(character) < ASCII_CONTROL_LIMIT or ord(character) == ASCII_DELETE or character == "\\" for character in value
    ):
        raise FileOperationError(64)
    if any(len(os.fsencode(part)) > NAME_BYTE_LIMIT for part in parts) or len(parts) > PATH_DEPTH_LIMIT:
        raise FileOperationError(64)
    return parts


@contextmanager
def directory_descriptor(parent: int, parts: list[str]) -> t.Iterator[int]:
    descriptor = os.dup(parent)
    try:
        for part in parts:
            child = os.open(part, DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


def file_identity(status: os.stat_result) -> tuple[int, int, int, int, int]:
    return status.st_dev, status.st_ino, status.st_size, status.st_mtime_ns, status.st_ctime_ns


@contextmanager
def regular_file(parent: int, name: str) -> t.Iterator[int]:
    # NONBLOCK avoids hanging on a FIFO before the regular-file check.
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        status = os.fstat(descriptor)
        if not stat.S_ISREG(status.st_mode):
            raise FileOperationError(64)
        if status.st_size > FILE_LIMIT:
            raise FileOperationError(75)
        yield descriptor
    finally:
        os.close(descriptor)


def emit_metadata(value: dict[str, object]) -> None:
    serialized = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode()
    if len(serialized) + 1 > METADATA_LIMIT:
        raise FileOperationError(75)
    sys.stdout.buffer.write(serialized + b"\n")


def read_regular_file(parent: int, name: str) -> None:
    with regular_file(parent, name) as descriptor:
        before = os.fstat(descriptor)
        count = 0
        while chunk := os.read(descriptor, 64 * 1024):
            count += len(chunk)
            if count > FILE_LIMIT:
                raise FileOperationError(75)
            sys.stdout.buffer.write(chunk)
        if count != before.st_size or file_identity(before) != file_identity(os.fstat(descriptor)):
            raise FileOperationError(74)


def list_directory(descriptor: int) -> None:
    entries: list[dict[str, object]] = []
    limit_reached = False
    # Do not sort or collect an unbounded scandir iterator.
    with os.scandir(descriptor) as scan:
        for entry in scan:
            if len(entries) == LIST_LIMIT:
                limit_reached = True
                break
            components(entry.name)
            status = entry.stat(follow_symlinks=False)
            kind = "file" if stat.S_ISREG(status.st_mode) else "directory" if stat.S_ISDIR(status.st_mode) else "unsupported"
            candidate: dict[str, object] = {"name": entry.name, "kind": kind}
            if kind == "file":
                candidate["byteLength"] = status.st_size
            entries.append(candidate)
            if len(json.dumps({"entries": entries, "limitReached": False}, separators=(",", ":"), ensure_ascii=True).encode()) + 1 > METADATA_LIMIT:
                entries.pop()
                limit_reached = True
                break
    emit_metadata({"entries": entries, "limitReached": limit_reached})


def inspect_folder(descriptor: int) -> None:
    count = 0
    byte_length = 0

    def inspect_directory(current: int, depth: int) -> None:
        nonlocal count, byte_length
        if depth > PATH_DEPTH_LIMIT:
            raise FileOperationError(75)
        with os.scandir(current) as scan:
            for entry in scan:
                count += 1
                if count > INVENTORY_LIMIT:
                    raise FileOperationError(75)
                components(entry.name)
                status = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(status.st_mode):
                    with directory_descriptor(current, [entry.name]) as child:
                        inspect_directory(child, depth + 1)
                elif stat.S_ISREG(status.st_mode):
                    if status.st_size > FILE_LIMIT:
                        raise FileOperationError(75)
                    byte_length += status.st_size
                    if byte_length > TOTAL_LIMIT:
                        raise FileOperationError(75)
                # Symlinks/special files are never followed or readable.

    inspect_directory(descriptor, 0)
    emit_metadata({"byteLength": byte_length, "entryCount": count})


def publish_file(parent: int, name: str, extra: list[str]) -> None:
    if len(extra) != PUBLISH_EXTRA_ARGUMENTS:
        raise FileOperationError(64)
    destination, raw_size, expected_hash = extra
    if len(components(destination)) != 1 or destination == name:
        raise FileOperationError(64)
    if (
        not raw_size.isascii()
        or not raw_size.isdecimal()
        or len(expected_hash) != SHA256_HEX_LENGTH
        or any(character not in "0123456789abcdef" for character in expected_hash)
    ):
        raise FileOperationError(64)
    with regular_file(parent, name) as descriptor:
        before = os.fstat(descriptor)
        digest = hashlib.sha256()
        count = 0
        while chunk := os.read(descriptor, 64 * 1024):
            count += len(chunk)
            if count > FILE_LIMIT:
                raise FileOperationError(75)
            digest.update(chunk)
        if before.st_size != int(raw_size) or digest.hexdigest() != expected_hash:
            raise FileOperationError(74)
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if file_identity(before) != file_identity(os.fstat(descriptor)) or file_identity(before) != file_identity(current):
            raise FileOperationError(74)
        # link(), unlike rename(), cannot replace an existing name or interpret a
        # directory target as "put the file inside". Both names share one dir fd.
        os.link(name, destination, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        published = os.stat(destination, dir_fd=parent, follow_symlinks=False)
        if (published.st_dev, published.st_ino) != (before.st_dev, before.st_ino):
            raise FileOperationError(74)
        cleanup = "complete"
        try:
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
                raise FileOperationError(74)
            os.unlink(name, dir_fd=parent)
        except (OSError, FileOperationError):
            cleanup = "pending"
        emit_metadata({"kind": "published", "cleanup": cleanup})


def remove_owned_path(parent: int, name: str) -> None:
    status = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISDIR(status.st_mode):
        if not shutil.rmtree.avoids_symlink_attacks:
            raise FileOperationError(64)
        shutil.rmtree(name, dir_fd=parent)
    elif stat.S_ISREG(status.st_mode):
        os.unlink(name, dir_fd=parent)
    else:
        raise FileOperationError(64)


def dispatch(root: int, action: str, relative_path: str, extra: list[str]) -> None:
    parts = components(relative_path, allow_empty=action in {"list", "inventory"})
    if action in {"list", "inventory"}:
        if extra:
            raise FileOperationError(64)
        with directory_descriptor(root, parts) as directory:
            if action == "list":
                list_directory(directory)
            else:
                inspect_folder(directory)
        return
    with directory_descriptor(root, parts[:-1]) as parent:
        name = parts[-1]
        if action == "read" and not extra:
            read_regular_file(parent, name)
        elif action == "mkdir" and not extra:
            os.mkdir(name, mode=0o700, dir_fd=parent)
        elif action == "publish":
            publish_file(parent, name, extra)
        elif action == "remove" and not extra:
            remove_owned_path(parent, name)
        else:
            raise FileOperationError(64)


def main() -> None:
    if len(sys.argv) < REQUIRED_ARGUMENTS:
        raise FileOperationError(64)
    action, root_path, relative_path, *extra = sys.argv[1:]
    if not root_path.startswith("/") or root_path == "/":
        raise FileOperationError(64)
    root_parts = components(root_path[1:])
    filesystem_root = os.open("/", DIRECTORY_FLAGS)
    try:
        with directory_descriptor(filesystem_root, root_parts) as root:
            dispatch(root, action, relative_path, extra)
    finally:
        os.close(filesystem_root)


if __name__ == "__main__":
    try:
        main()
    except FileOperationError as error:
        sys.stderr.write("operation-file-request-failed\n")
        sys.exit(error.code)
    except OSError as error:
        sys.stderr.write("operation-file-request-failed\n")
        sys.exit(73 if error.errno == errno.EEXIST else 64 if error.errno in {errno.ELOOP, errno.ENOTDIR} else 66 if error.errno == errno.ENOENT else 74)
