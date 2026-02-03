/**
 * Detect user information for onboarding
 * Returns JSON with system, git, github, and code directory info
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

interface GitInfo {
  name: string;
  email: string;
}

interface GitHubInfo {
  login?: string;
  name?: string;
  blog?: string;
  bio?: string;
}

export interface UserInfo {
  username: string;
  fullName: string;
  timezone: string;
  git: GitInfo;
  github: GitHubInfo;
  codeDirs: string[];
}

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

export function detectUser(): UserInfo {
  // System info
  const username = exec("whoami");
  const fullName = exec("id -F") || exec(`getent passwd ${username} | cut -d: -f5 | cut -d, -f1`);

  // Timezone
  let timezone = "";
  if (existsSync("/etc/timezone")) {
    timezone = exec("cat /etc/timezone");
  } else if (existsSync("/etc/localtime")) {
    timezone = exec("readlink /etc/localtime | sed 's|.*/zoneinfo/||'");
  }

  // Git config
  const gitName = exec("git config --global user.name");
  const gitEmail = exec("git config --global user.email");

  // GitHub CLI (if authenticated)
  let github: GitHubInfo = {};
  const ghCheck = exec("command -v gh");
  if (ghCheck) {
    const ghJson = exec("gh api user --jq '{login: .login, name: .name, blog: .blog, bio: .bio}'");
    if (ghJson) {
      try {
        github = JSON.parse(ghJson);
      } catch {
        // Ignore parse errors
      }
    }
  }

  // Code directories that exist
  const home = homedir();
  const possibleDirs = [
    "Repos", "repos", "Code", "code", "Projects", "projects", 
    "Developer", "dev", "src"
  ];
  const codeDirs = possibleDirs
    .map(dir => join(home, dir))
    .filter(dir => existsSync(dir));

  return {
    username,
    fullName,
    timezone,
    git: {
      name: gitName,
      email: gitEmail,
    },
    github,
    codeDirs,
  };
}
