/** A tiny polyglot repository for the scanner tests: one service per language, with routes. */
const enc = new TextEncoder();

export const REPO: Record<string, string> = {
  'src/auth/session.ts': `import { hashToken } from './crypto';
import * as db from '../db.js';

/** Creates a session for a signed-in user. */
export function createSession(userId: string, ttlMs: number): Session {
  const token = hashToken(userId);
  db.insert('sessions', token);
  return { userId, token, expiresAt: Date.now() + ttlMs };
}

export interface Session { userId: string; token: string; expiresAt: number }

export class SessionStore extends BaseStore implements Store {
  private items = new Map<string, Session>();
  get(token: string): Session | undefined { return this.items.get(token); }
  put(s: Session) { this.items.set(s.token, s); this.touch(); }
  touch() {}
}

class BaseStore {}

export const SESSION_COOKIE: string = 'sid';
export const revoke = async (token: string): Promise<void> => { db.remove('sessions', token); };
`,
  'src/auth/crypto.ts': `export function hashToken(s: string): string { return s.split('').reverse().join(''); }
`,
  'src/db.ts': `export function insert(table: string, value: string) {}
export function remove(table: string, value: string) {}
`,
  'src/server.ts': `import express from 'express';
import { createSession } from './auth/session';
const app = express();
app.get('/health', health);
app.post('/login', (req, res) => { res.json(createSession(req.body.user, 3600)); });
function health(_req: unknown, res: { send(s: string): void }) { res.send('ok'); }
`,
  'api/app.py': `from flask import Flask
from .models import User, load_user

app = Flask(__name__)
MAX_USERS = 100

@app.route("/users/<id>", methods=["GET", "DELETE"])
def user(id):
    """Reads or deletes a user."""
    return load_user(id).to_json()

class Repo(Base):
    def find(self, id: str) -> User:
        return self._lookup(id)

    def _lookup(self, id):
        return None
`,
  'api/models.py': `class User:
    def to_json(self):
        return {}

def load_user(id: str) -> User:
    return User()
`,
  'api/__init__.py': '',
  'go.mod': 'module example.com/shop\n\ngo 1.22\n',
  'cmd/main.go': `package main

import (
	"net/http"
	"example.com/shop/store"
)

// Starts the shop.
func main() {
	s := store.New()
	http.HandleFunc("/items", s.ListItems)
	http.HandleFunc("POST /items", s.AddItem)
	http.ListenAndServe(":8080", nil)
}
`,
  'store/store.go': `package store

type Store struct{ items []string }

type Reader interface{ ListItems() }

const MaxItems = 50

func New() *Store { return &Store{} }

func (s *Store) ListItems(w any, r any) { s.count() }
func (s *Store) AddItem(w any, r any) {}
func (s *Store) count() int { return len(s.items) }
`,
  'src/lib.rs': `pub mod routes;

/// A ledger entry.
pub struct Entry { pub amount: i64 }

pub trait Ledger { fn total(&self) -> i64; }

impl Ledger for Entry {
    fn total(&self) -> i64 { helper(self.amount) }
}

fn helper(x: i64) -> i64 { x }

pub const LIMIT: i64 = 10;
`,
  'src/routes.rs': `use crate::Entry;

pub fn router() -> Router {
    Router::new().route("/entries", get(list_entries).post(add_entry))
}

async fn list_entries() {}
async fn add_entry() {}
`,
  'java/com/acme/OrderController.java': `package com.acme;

import com.acme.OrderService;

@RequestMapping("/orders")
public class OrderController {
    private final OrderService service = new OrderService();

    @GetMapping("/{id}")
    public Order get(String id) { return service.find(id); }

    @PostMapping
    public Order create(Order o) { return service.save(o); }
}
`,
  'java/com/acme/OrderService.java': `package com.acme;

public class OrderService {
    public Order find(String id) { return null; }
    public Order save(Order o) { return o; }
}
`,
  'node_modules/leftpad/index.js': 'export function leftpad() {}',
  'dist/app.min.js': 'function x(){}',
  'README.md': '# Shop',
};

export function repoFiles(overrides: Record<string, string | null> = {}) {
  const all = { ...REPO, ...overrides };
  return Object.entries(all).filter(([, v]) => v !== null).map(([path, text]) => ({ path, bytes: enc.encode(text as string) }));
}
