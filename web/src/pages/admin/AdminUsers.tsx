import React, { useState } from 'react'
import { api, ApiError } from '../../api'
import { useAuth } from '../../auth'
import { Button, Card, EmptyState, ErrorState, Field, Loading, Modal } from '../../components/ui'
import { formatIstDateTime } from '../../format'
import { useApi } from '../../hooks'
import type { AdminUserRow } from '../../types'

export default function AdminUsers(): React.ReactElement {
  const { user: currentUser } = useAuth()
  const usersApi = useApi(() => api.adminUsers(), [])
  const users = usersApi.data ?? []

  const [addingOpen, setAddingOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'committee'>('admin')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onAddUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const cleanEmail = email.trim().toLowerCase()
    if (!cleanEmail) {
      setError('Please enter a corporate email address')
      return
    }
    if (!cleanEmail.endsWith('@acceleronsolutions.io')) {
      setError('Only company emails from @acceleronsolutions.io are permitted')
      return
    }

    setBusy(true)
    try {
      await api.addAdminUser(cleanEmail, role)
      setEmail('')
      setRole('admin')
      setAddingOpen(false)
      usersApi.reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add admin user')
    } finally {
      setBusy(false)
    }
  }

  const onRoleChange = async (targetEmail: string, newRole: 'admin' | 'committee') => {
    try {
      await api.updateAdminUserRole(targetEmail, newRole)
      usersApi.reload()
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to update user role')
    }
  }

  const onRemoveUser = async (targetEmail: string) => {
    if (!window.confirm(`Are you sure you want to revoke console access for ${targetEmail}?`)) {
      return
    }
    try {
      await api.removeAdminUser(targetEmail)
      usersApi.reload()
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to remove admin user')
    }
  }

  return (
    <>
      <Card
        title="Admin & Committee Console Users"
        sub="Manage authorized administrators and R&R committee members with access to the console"
        actions={
          <Button small variant="primary" onClick={() => setAddingOpen(true)}>
            + Add Console User
          </Button>
        }
      >
        <div style={{ marginBottom: 18, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
          Authorized users can log into the web console using their corporate{' '}
          <strong style={{ color: 'var(--ink)' }}>@acceleronsolutions.io</strong> email address and a one-time passcode (OTP).
        </div>

        {usersApi.loading ? (
          <Loading />
        ) : usersApi.error ? (
          <ErrorState error={usersApi.error} retry={() => usersApi.reload()} />
        ) : users.length === 0 ? (
          <EmptyState title="No admin users found" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>User / Email</th>
                  <th>Role</th>
                  <th>Site & Department</th>
                  <th>Enrolled On</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isCurrent = currentUser?.email.toLowerCase() === u.email.toLowerCase()
                  return (
                    <tr key={u.email}>
                      <td>
                        <div style={{ fontWeight: 700, color: 'var(--ink)' }}>
                          {u.employeeName || u.email.split('@')[0]}
                          {isCurrent && (
                            <span
                              style={{
                                marginLeft: 8,
                                fontSize: 10,
                                padding: '2px 6px',
                                background: 'var(--navy-50)',
                                color: 'var(--navy-600)',
                                borderRadius: 4,
                                fontWeight: 800,
                              }}
                            >
                              YOU
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{u.email}</div>
                      </td>
                      <td>
                        <span
                          className={`badge ${u.role === 'admin' ? 'badge-warn' : 'badge-neutral'}`}
                          style={{
                            background: u.role === 'admin' ? 'var(--red-50)' : 'var(--navy-50)',
                            color: u.role === 'admin' ? 'var(--brand-red)' : 'var(--navy-600)',
                            borderColor: u.role === 'admin' ? 'var(--red-200)' : 'var(--navy-200)',
                            fontWeight: 800,
                            textTransform: 'uppercase',
                            fontSize: 11,
                          }}
                        >
                          {u.role === 'admin' ? '⚡ Administrator' : '🛡️ Committee'}
                        </span>
                      </td>
                      <td>
                        <div style={{ fontSize: 12.5, color: 'var(--ink)' }}>
                          {u.employeeSite ? `${u.employeeSite} · ${u.employeeFunction}` : '—'}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                          {u.createdAt ? formatIstDateTime(u.createdAt) : '—'}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                          <select
                            className="select"
                            style={{ padding: '4px 8px', fontSize: 12, height: 30 }}
                            value={u.role}
                            onChange={(e) => void onRoleChange(u.email, e.target.value as 'admin' | 'committee')}
                          >
                            <option value="admin">Admin</option>
                            <option value="committee">Committee</option>
                          </select>
                          <Button
                            small
                            variant="danger"
                            onClick={() => void onRemoveUser(u.email)}
                            title="Revoke console access"
                            style={{ padding: '4px 8px', fontSize: 12, height: 30 }}
                          >
                            Revoke
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Add User Modal */}
      {addingOpen && (
        <Modal title="Add Console User" onClose={() => setAddingOpen(false)}>
          <form onSubmit={(e) => void onAddUser(e)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0' }}>
              <Field label="Corporate Email (@acceleronsolutions.io) *">
                <input
                  type="email"
                  className="input"
                  placeholder="name@acceleronsolutions.io"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  required
                />
              </Field>

              <Field label="Console Role *">
                <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                  <label
                    style={{
                      flex: 1,
                      border: `1.5px solid ${role === 'admin' ? 'var(--navy-600)' : 'var(--line)'}`,
                      background: role === 'admin' ? 'var(--navy-50)' : 'var(--surface)',
                      borderRadius: 'var(--radius)',
                      padding: '12px 14px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                    }}
                  >
                    <input
                      type="radio"
                      name="role"
                      value="admin"
                      checked={role === 'admin'}
                      onChange={() => setRole('admin')}
                      style={{ marginTop: 2 }}
                    />
                    <div>
                      <div style={{ fontWeight: 700, color: 'var(--navy-600)', fontSize: 13.5 }}>
                        Administrator
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                        Full access (directory, bulk uploads, behaviours, admin users, settings, moderation)
                      </div>
                    </div>
                  </label>

                  <label
                    style={{
                      flex: 1,
                      border: `1.5px solid ${role === 'committee' ? 'var(--navy-600)' : 'var(--line)'}`,
                      background: role === 'committee' ? 'var(--navy-50)' : 'var(--surface)',
                      borderRadius: 'var(--radius)',
                      padding: '12px 14px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                    }}
                  >
                    <input
                      type="radio"
                      name="role"
                      value="committee"
                      checked={role === 'committee'}
                      onChange={() => setRole('committee')}
                      style={{ marginTop: 2 }}
                    />
                    <div>
                      <div style={{ fontWeight: 700, color: 'var(--navy-600)', fontSize: 13.5 }}>
                        Committee Member
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                        Live feed, recognition moderation, analytics dashboard, reports & export
                      </div>
                    </div>
                  </label>
                </div>
              </Field>

              {error && (
                <div className="notice notice-error" style={{ fontSize: 13 }}>
                  {error}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
                <Button type="button" onClick={() => setAddingOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" busy={busy}>
                  Grant Access
                </Button>
              </div>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
