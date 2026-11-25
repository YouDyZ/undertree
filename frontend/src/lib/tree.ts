import type { Entry, Repo, Tree } from "../api";

export interface TreeNode {
  path: string;
  name: string;
  kind: "file" | "dir";
  repo: string;
  submodule?: Repo;
  children: TreeNode[];
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
]);

const TEXT_EXTENSIONS = new Set([
  ".tex",
  ".bib",
  ".sty",
  ".cls",
  ".bst",
  ".dtx",
  ".ins",
  ".txt",
  ".md",
  ".markdown",
  ".latexmkrc",
  ".gitignore",
  ".gitmodules",
  ".yml",
  ".yaml",
  ".json",
  ".toml",
  ".csv",
  ".tsv",
  ".sh",
  ".py",
  ".rs",
  ".ts",
  ".tsx",
  ".js",
  ".css",
  ".html",
  ".xml",
  ".makefile",
]);

function getExtension(path: string): string {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  if (base === "makefile" || base === "dockerfile" || base === ".latexmkrc") {
    return `.${base.replace(/^\./, "")}`;
  }
  const idx = base.lastIndexOf(".");
  return idx >= 0 ? base.slice(idx) : "";
}

export function isImageFile(path: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(path));
}

export function isTextFile(path: string): boolean {
  const ext = getExtension(path);
  return TEXT_EXTENSIONS.has(ext);
}

export function isTexFile(path: string): boolean {
  return path.toLowerCase().endsWith(".tex");
}

function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    const aIsDir = a.kind === "dir" ? 0 : 1;
    const bIsDir = b.kind === "dir" ? 0 : 1;
    if (aIsDir !== bIsDir) return aIsDir - bIsDir;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  for (const node of nodes) {
    if (node.children.length > 0) {
      sortNodes(node.children);
    }
  }
}

/**
 * Builds a nested file tree from flat `/api/tree` entries & repos.
 * Guarantees that every submodule (including uninitialized ones with no entries)
 * is represented as a directory node annotated with its `Repo` metadata.
 */
export function buildTreeNodes(tree: Tree): TreeNode[] {
  const submoduleByPath = new Map<string, Repo>();
  for (const repo of tree.repos) {
    if (repo.kind === "submodule" && repo.path) {
      submoduleByPath.set(repo.path, repo);
    }
  }

  const nodeMap = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  const ensureDir = (dirPath: string, repoPath: string): TreeNode => {
    const existing = nodeMap.get(dirPath);
    if (existing) {
      const sub = submoduleByPath.get(dirPath);
      if (sub && !existing.submodule) {
        existing.submodule = sub;
      }
      return existing;
    }

    const parts = dirPath.split("/");
    const name = parts[parts.length - 1] ?? dirPath;
    const sub = submoduleByPath.get(dirPath);
    const node: TreeNode = {
      path: dirPath,
      name,
      kind: "dir",
      repo: sub ? sub.path : repoPath,
      submodule: sub,
      children: [],
    };
    nodeMap.set(dirPath, node);

    if (parts.length === 1) {
      roots.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join("/");
      const parentRepo = findContainingRepo(parentPath, submoduleByPath);
      const parent = ensureDir(parentPath, parentRepo);
      parent.children.push(node);
    }
    return node;
  };

  // Ensure all submodules (especially uninitialized ones) appear in the tree.
  for (const sub of submoduleByPath.values()) {
    ensureDir(sub.path, sub.path);
  }

  const addEntry = (entry: Entry): void => {
    if (entry.kind === "dir") {
      ensureDir(entry.path, entry.repo);
      return;
    }
    if (nodeMap.has(entry.path)) return;

    const parts = entry.path.split("/");
    const name = parts[parts.length - 1] ?? entry.path;
    const node: TreeNode = {
      path: entry.path,
      name,
      kind: "file",
      repo: entry.repo,
      children: [],
    };
    nodeMap.set(entry.path, node);

    if (parts.length === 1) {
      roots.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join("/");
      const parentRepo = findContainingRepo(parentPath, submoduleByPath);
      const parent = ensureDir(parentPath, parentRepo);
      parent.children.push(node);
    }
  };

  for (const entry of tree.entries) {
    addEntry(entry);
  }

  sortNodes(roots);
  return roots;
}

function findContainingRepo(path: string, submoduleByPath: Map<string, Repo>): string {
  let best = "";
  for (const subPath of submoduleByPath.keys()) {
    if (path === subPath || path.startsWith(`${subPath}/`)) {
      if (subPath.length > best.length) {
        best = subPath;
      }
    }
  }
  return best;
}

/**
 * Filters a tree by case-insensitive substring match against node path/name,
 * keeping parent folders of matching descendants.
 */
export function filterTreeNodes(nodes: TreeNode[], rawQuery: string): TreeNode[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return nodes;

  const result: TreeNode[] = [];
  for (const node of nodes) {
    const matchesSelf =
      node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query);
    if (node.kind === "file") {
      if (matchesSelf) result.push(node);
    } else {
      const filteredChildren = filterTreeNodes(node.children, query);
      if (matchesSelf || filteredChildren.length > 0) {
        result.push({
          ...node,
          children: matchesSelf ? node.children : filteredChildren,
        });
      }
    }
  }
  return result;
}
