/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Default Editor - Editor to open repos and files in. Shared by all Ashlr commands. */
  "editor": "cursor" | "vscode"
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `search-everything` command */
  export type SearchEverything = ExtensionPreferences & {}
  /** Preferences accessible in the `attention-board` command */
  export type AttentionBoard = ExtensionPreferences & {}
  /** Preferences accessible in the `ceo-dashboard` command */
  export type CeoDashboard = ExtensionPreferences & {}
  /** Preferences accessible in the `tidy-desktop` command */
  export type TidyDesktop = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `search-everything` command */
  export type SearchEverything = {}
  /** Arguments passed to the `attention-board` command */
  export type AttentionBoard = {}
  /** Arguments passed to the `ceo-dashboard` command */
  export type CeoDashboard = {}
  /** Arguments passed to the `tidy-desktop` command */
  export type TidyDesktop = {}
}

