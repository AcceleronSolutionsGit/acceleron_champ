import React, { useState } from 'react'
import { api, ApiError } from '../../api'
import { Button, Modal } from '../../components/ui'
import type { BulkUploadResult } from '../../types'

interface BulkUploadModalProps {
  onClose: () => void
  onSuccess: () => void
}

interface ParsedEmployeeRow {
  rowNum: number
  name: string
  mobile: string
  email: string
  site: string
  function: string
  employee_code?: string
  sub_team?: string
  shift?: string
  employment_type?: 'permanent' | 'contractual'
  level_grade?: string
  isValid: boolean
  error?: string
}

function cleanHeader(h: string): string {
  return h.toLowerCase().trim().replace(/[\s_-]+/g, '')
}

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"' || char === "'") {
      if (inQuotes && line[i + 1] === char) {
        current += char
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if ((char === ',' || char === '\t') && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  result.push(current.trim())
  return result
}

function normalizePhone(raw: string): string {
  let cleaned = raw.replace(/[^\d+]/g, '').trim()
  if (!cleaned) return ''
  if (!cleaned.startsWith('+')) {
    if (cleaned.length === 10) cleaned = `+91${cleaned}`
    else if (cleaned.length === 12 && cleaned.startsWith('91')) cleaned = `+${cleaned}`
    else cleaned = `+${cleaned}`
  }
  return cleaned
}

export default function BulkUploadModal({ onClose, onSuccess }: BulkUploadModalProps): React.ReactElement {
  const [tab, setTab] = useState<'file' | 'paste'>('file')
  const [pastedText, setPastedText] = useState('')
  const [parsedRows, setParsedRows] = useState<ParsedEmployeeRow[]>([])
  const [busy, setBusy] = useState(false)
  const [uploadResult, setUploadResult] = useState<BulkUploadResult | null>(null)
  const [generalError, setGeneralError] = useState<string | null>(null)

  const downloadSampleTemplate = () => {
    const sampleHeaders = 'Name,Mobile,Corporate Email,Site,Function,Employee Code,Sub Team,Shift,Employment Type,Level Grade\n'
    const sampleRows = [
      'John Doe,+919876543210,john.doe@acceleronsolutions.io,Kolkata,Engineering,ACC1001,Frontend,General,permanent,L2',
      'Priya Sharma,9876543211,priya.sharma@acceleronsolutions.io,Bengaluru,Product,,Design,General,permanent,L3',
      'Amit Patel,9876543212,amit.patel@acceleronsolutions.io,Panagarh,Manufacturing,ACC1003,Assembly,A,contractual,L1',
    ].join('\n')

    const blob = new Blob([sampleHeaders + sampleRows], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', 'acceleron_employees_template.csv')
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const processRawData = (text: string) => {
    setGeneralError(null)
    setUploadResult(null)

    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)

    if (lines.length === 0) {
      setParsedRows([])
      return
    }

    const firstLineCols = parseCSVLine(lines[0])
    const headers = firstLineCols.map(cleanHeader)

    // Map column names flexibly
    const colMap: Record<string, number> = {}
    headers.forEach((h, idx) => {
      if (h === 'name' || h === 'fullname' || h === 'employeename') colMap.name = idx
      else if (h === 'mobile' || h === 'phone' || h === 'phonenumber' || h === 'mobilenumber' || h === 'contact') colMap.mobile = idx
      else if (h === 'email' || h === 'corporateemail' || h === 'companyemail' || h === 'workemail' || h === 'emailid') colMap.email = idx
      else if (h === 'site' || h === 'location' || h === 'office' || h === 'plant' || h === 'branch') colMap.site = idx
      else if (h === 'function' || h === 'department' || h === 'dept' || h === 'team') colMap.function = idx
      else if (h === 'employeecode' || h === 'empcode' || h === 'code' || h === 'employeeid' || h === 'empid') colMap.employee_code = idx
      else if (h === 'subteam' || h === 'section' || h === 'project') colMap.sub_team = idx
      else if (h === 'shift' || h === 'workshift') colMap.shift = idx
      else if (h === 'employmenttype' || h === 'type') colMap.employment_type = idx
      else if (h === 'levelgrade' || h === 'grade' || h === 'level') colMap.level_grade = idx
    })

    const hasHeader =
      colMap.name !== undefined ||
      colMap.mobile !== undefined ||
      colMap.email !== undefined ||
      colMap.site !== undefined ||
      colMap.function !== undefined

    const dataLines = hasHeader ? lines.slice(1) : lines

    if (dataLines.length === 0) {
      setGeneralError('No data rows found in the provided input.')
      setParsedRows([])
      return
    }

    const seenEmails = new Set<string>()
    const seenMobiles = new Set<string>()

    const rows: ParsedEmployeeRow[] = dataLines.map((line, i) => {
      const rowNum = i + 1
      const cols = parseCSVLine(line)

      const name = (hasHeader && colMap.name !== undefined ? cols[colMap.name] : cols[0]) || ''
      const mobileRaw = (hasHeader && colMap.mobile !== undefined ? cols[colMap.mobile] : cols[1]) || ''
      const emailRaw = (hasHeader && colMap.email !== undefined ? cols[colMap.email] : cols[2]) || ''
      const site = (hasHeader && colMap.site !== undefined ? cols[colMap.site] : cols[3]) || ''
      const fn = (hasHeader && colMap.function !== undefined ? cols[colMap.function] : cols[4]) || ''
      const employeeCode = (hasHeader && colMap.employee_code !== undefined ? cols[colMap.employee_code] : cols[5]) || ''
      const subTeam = (hasHeader && colMap.sub_team !== undefined ? cols[colMap.sub_team] : cols[6]) || ''
      const shift = (hasHeader && colMap.shift !== undefined ? cols[colMap.shift] : cols[7]) || 'General'
      const empTypeRaw = (hasHeader && colMap.employment_type !== undefined ? cols[colMap.employment_type] : cols[8]) || 'permanent'
      const levelGrade = (hasHeader && colMap.level_grade !== undefined ? cols[colMap.level_grade] : cols[9]) || 'L2'

      const email = emailRaw.trim().toLowerCase()
      const normalizedMobile = normalizePhone(mobileRaw)

      const errors: string[] = []

      if (!name || name.length < 2) errors.push('Name is required (min 2 chars)')
      if (!mobileRaw) errors.push('Mobile is required')
      else if (!/^\+[1-9]\d{7,14}$/.test(normalizedMobile)) errors.push(`Invalid phone format (${mobileRaw})`)

      if (!email) errors.push('Corporate email is required')
      else if (!email.includes('@')) errors.push('Invalid email format')
      else if (!email.endsWith('@acceleronsolutions.io')) {
        errors.push('Must be @acceleronsolutions.io email')
      }

      if (!site) errors.push('Site/Location is required')
      if (!fn) errors.push('Function/Department is required')

      // Check duplicates in batch
      if (email) {
        if (seenEmails.has(email)) errors.push(`Duplicate email in batch: ${email}`)
        else seenEmails.add(email)
      }

      if (normalizedMobile) {
        if (seenMobiles.has(normalizedMobile)) errors.push(`Duplicate phone in batch: ${normalizedMobile}`)
        else seenMobiles.add(normalizedMobile)
      }

      const employment_type = empTypeRaw.toLowerCase().includes('contract') ? 'contractual' : 'permanent'

      return {
        rowNum,
        name: name.trim(),
        mobile: normalizedMobile,
        email,
        site: site.trim(),
        function: fn.trim(),
        employee_code: employeeCode.trim() || undefined,
        sub_team: subTeam.trim() || undefined,
        shift: shift.trim() || 'General',
        employment_type,
        level_grade: levelGrade.trim() || 'L2',
        isValid: errors.length === 0,
        error: errors.length > 0 ? errors.join('; ') : undefined,
      }
    })

    setParsedRows(rows)
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (evt) => {
      const content = evt.target?.result
      if (typeof content === 'string') {
        processRawData(content)
      }
    }
    reader.readAsText(file)
  }

  const handlePasteSubmit = () => {
    if (!pastedText.trim()) {
      setGeneralError('Please paste employee data or CSV text first.')
      return
    }
    processRawData(pastedText)
  }

  const validRows = parsedRows.filter((r) => r.isValid)
  const invalidRows = parsedRows.filter((r) => !r.isValid)

  const handleExecuteUpload = async () => {
    if (validRows.length === 0) {
      setGeneralError('No valid rows to import.')
      return
    }
    setBusy(true)
    setGeneralError(null)
    try {
      const payload = validRows.map((r) => ({
        name: r.name,
        mobile: r.mobile,
        email: r.email,
        site: r.site,
        function: r.function,
        employee_code: r.employee_code,
        sub_team: r.sub_team,
        shift: r.shift,
        employment_type: r.employment_type,
        level_grade: r.level_grade,
        consent_recorded: true,
      }))

      const result = await api.bulkUploadEmployees(payload)
      setUploadResult(result)
      if (result.insertedCount > 0) {
        onSuccess()
      }
    } catch (err) {
      setGeneralError(err instanceof ApiError ? err.message : 'Bulk upload failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Bulk Upload Employees" wide onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Top Instructions Banner */}
        <div
          style={{
            background: 'var(--navy-50)',
            border: '1px solid var(--navy-200)',
            borderRadius: 'var(--radius)',
            padding: '16px 20px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontWeight: 800, color: 'var(--navy-600)', fontSize: 14 }}>
              Bulk Enrolment with Acceleron Corporate Emails
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
              Required fields: <strong style={{ color: 'var(--ink)' }}>Name, Mobile, Corporate Email (@acceleronsolutions.io), Site, Function</strong>.
            </div>
          </div>
          <Button small onClick={downloadSampleTemplate} style={{ whiteSpace: 'nowrap' }}>
            📥 Download Sample CSV
          </Button>
        </div>

        {/* Input Method Tabs */}
        {!uploadResult && (
          <div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                type="button"
                className={`btn btn-sm ${tab === 'file' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setTab('file')}
              >
                📁 Upload CSV File
              </button>
              <button
                type="button"
                className={`btn btn-sm ${tab === 'paste' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setTab('paste')}
              >
                📋 Paste Tabular / CSV Data
              </button>
            </div>

            {tab === 'file' ? (
              <div
                style={{
                  border: '2px dashed var(--line)',
                  borderRadius: 'var(--radius)',
                  padding: '30px 20px',
                  textAlign: 'center',
                  background: 'var(--surface)',
                  cursor: 'pointer',
                  transition: 'border-color 0.2s',
                }}
                onClick={() => document.getElementById('bulk-file-input')?.click()}
              >
                <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
                <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--navy-600)' }}>
                  Click to select CSV file from your computer
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                  Supports .csv and text exports from Excel or Google Sheets
                </div>
                <input
                  id="bulk-file-input"
                  type="file"
                  accept=".csv,.txt"
                  style={{ display: 'none' }}
                  onChange={handleFileUpload}
                />
              </div>
            ) : (
              <div>
                <textarea
                  className="input"
                  rows={6}
                  placeholder={`Paste CSV lines here, e.g.:\nName,Mobile,Corporate Email,Site,Function\nJohn Doe,+919876543210,john.doe@acceleronsolutions.io,Kolkata,Engineering`}
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 12.5 }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                  <Button small variant="primary" onClick={handlePasteSubmit}>
                    Parse Pasted Data
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {generalError && (
          <div className="notice notice-error" style={{ fontSize: 13 }}>
            {generalError}
          </div>
        )}

        {/* Completion Result Banner */}
        {uploadResult && (
          <div
            style={{
              background: uploadResult.failedCount === 0 ? 'var(--navy-50)' : 'var(--red-50)',
              border: `1px solid ${uploadResult.failedCount === 0 ? 'var(--navy-200)' : 'var(--red-200)'}`,
              borderRadius: 'var(--radius)',
              padding: '16px 20px',
            }}
          >
            <div style={{ fontWeight: 800, fontSize: 15, color: uploadResult.failedCount === 0 ? 'var(--navy-600)' : 'var(--brand-red)' }}>
              {uploadResult.insertedCount > 0 ? `🎉 Successfully imported ${uploadResult.insertedCount} employees!` : 'Upload completed with issues'}
            </div>
            {uploadResult.failedCount > 0 && (
              <div style={{ fontSize: 13, color: 'var(--brand-red-dark)', marginTop: 6 }}>
                {uploadResult.failedCount} rows could not be inserted due to duplicate records or database conflicts.
              </div>
            )}
          </div>
        )}

        {/* Parsed Preview Table */}
        {parsedRows.length > 0 && !uploadResult && (
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 10,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--ink)' }}>
                Validation Preview ({parsedRows.length} total rows)
              </div>
              <div style={{ display: 'flex', gap: 10, fontSize: 12, fontWeight: 700 }}>
                <span style={{ color: 'var(--navy-600)' }}>✓ {validRows.length} Valid</span>
                {invalidRows.length > 0 && <span style={{ color: 'var(--brand-red)' }}>✗ {invalidRows.length} Invalid</span>}
              </div>
            </div>

            <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Name</th>
                    <th>Mobile</th>
                    <th>Corporate Email</th>
                    <th>Site</th>
                    <th>Function</th>
                    <th>Code</th>
                    <th>Details / Error</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedRows.map((r, idx) => (
                    <tr key={idx} style={{ background: r.isValid ? undefined : 'var(--red-50)' }}>
                      <td>
                        {r.isValid ? (
                          <span style={{ color: 'var(--navy-600)', fontWeight: 800, fontSize: 12 }}>✓ Valid</span>
                        ) : (
                          <span style={{ color: 'var(--brand-red)', fontWeight: 800, fontSize: 12 }}>✗ Error</span>
                        )}
                      </td>
                      <td style={{ fontWeight: 700 }}>{r.name || '—'}</td>
                      <td>{r.mobile || '—'}</td>
                      <td>{r.email || '—'}</td>
                      <td>{r.site || '—'}</td>
                      <td>{r.function || '—'}</td>
                      <td>{r.employee_code || '(auto)'}</td>
                      <td style={{ color: r.isValid ? 'var(--muted)' : 'var(--brand-red)', fontSize: 11.5 }}>
                        {r.isValid ? `${r.employment_type} · ${r.shift}` : r.error}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Modal Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 8 }}>
          <Button onClick={onClose}>{uploadResult ? 'Close' : 'Cancel'}</Button>
          {!uploadResult && parsedRows.length > 0 && (
            <Button
              variant="primary"
              busy={busy}
              disabled={validRows.length === 0}
              onClick={() => void handleExecuteUpload()}
            >
              Import {validRows.length} Valid Employees
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
