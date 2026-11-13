import React, { useEffect, useState, useMemo } from 'react';
import { isMetre, lengthText, itemsIn } from '../units';
import { Link, useParams } from 'react-router-dom';
import { getOrder, getAccount, heldProof, money } from '../api';
import { signedIn } from '../account';
import { ORDER_WORDS } from '../orderWords';
import { EmptyOrders } from '../components/Motion';
import { sized, orWhole, THUMB } from '../photo';

/**
 * Status visual configurations with distinct styles and icons
 */
const STATUS_CONFIG = {
  PLACED: {
    label: 'Order Placed',
    variant: 'placed',
    step: 1,
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    )
  },
  PACKED: {
    label: 'Packed & Ready',
    variant: 'packed',
    step: 2,
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m7.5 4.27 9 5.15" />
        <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
        <path d="m3.3 7 8.7 5 8.7-5" />
        <path d="M12 22V12" />
      </svg>
    )
  },
  PART_PACKED: {
    label: 'Partially Packed',
    variant: 'packed',
    step: 2,
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      </svg>
    )
  },
  PART_SENT: {
    label: 'Partially Shipped',
    variant: 'sent',
    step: 3,
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="16" height="13" x="1" y="6" rx="2" />
        <path d="M17 9h4l2 3v4a2 2 0 0 1-2 2h-4" />
        <circle cx="5.5" cy="18.5" r="2.5" />
        <circle cx="18.5" cy="18.5" r="2.5" />
      </svg>
    )
  },
  SENT: {
    label: 'On the Way',
    variant: 'sent',
    step: 3,
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="16" height="13" x="1" y="6" rx="2" />
        <path d="M17 9h4l2 3v4a2 2 0 0 1-2 2h-4" />
        <circle cx="5.5" cy="18.5" r="2.5" />
        <circle cx="18.5" cy="18.5" r="2.5" />
      </svg>
    )
  },
  OUT_FOR_DELIVERY: {
    label: 'Out for Delivery Today',
    variant: 'out',
    step: 3,
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
        <circle cx="12" cy="10" r="3" />
      </svg>
    )
  },
  DELIVERED: {
    label: 'Delivered',
    variant: 'delivered',
    step: 4,
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )
  },
  TROUBLE: {
    label: 'Delivery Issue',
    variant: 'trouble',
    step: 3,
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    )
  },
  CANCELLED: {
    label: 'Cancelled',
    variant: 'cancelled',
    step: 0,
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    )
  }
};

const STEP_LABELS = ['Placed', 'Packed', 'On the way', 'Delivered'];

function kept(slug) {
  try { return JSON.parse(window.localStorage.getItem(`scaleezy.orders.${slug}`) ?? '[]'); }
  catch { return []; }
}

export default function MyOrdersPage({ shop }) {
  const { slug } = useParams();
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const fromAccount = signedIn(slug)
        ? ((await getAccount(slug, heldProof(slug)).catch(() => null))?.orders ?? []).map(o => ({ token: o.token }))
        : [];
      const seen = new Set();
      const held = [...fromAccount, ...kept(slug)].filter(o => o?.token && !seen.has(o.token) && seen.add(o.token));
      if (!held.length) return [];
      return Promise.all(held.map(o => getOrder(slug, o.token).catch(() => null)));
    })().then(list => {
      if (!alive) return;
      setRows(list.filter(Boolean).sort((a, b) => String(b.placedAt).localeCompare(String(a.placedAt))));
    });
    return () => { alive = false; };
  }, [slug]);

  const copyOrderNo = async (num, e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(num);
      } else {
        const ta = document.createElement('textarea');
        ta.value = num;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(num);
      setTimeout(() => setCopied(null), 2000);
    } catch { /* clipboard permission */ }
  };

  const counts = useMemo(() => {
    if (!rows) return { all: 0, active: 0, delivered: 0, cancelled: 0 };
    return {
      all: rows.length,
      active: rows.filter(o => ['PLACED', 'PACKED', 'PART_PACKED', 'PART_SENT', 'SENT', 'OUT_FOR_DELIVERY', 'TROUBLE'].includes(o.state)).length,
      delivered: rows.filter(o => o.state === 'DELIVERED').length,
      cancelled: rows.filter(o => o.state === 'CANCELLED').length
    };
  }, [rows]);

  const filteredOrders = useMemo(() => {
    if (!rows) return [];
    return rows.filter(o => {
      if (filter === 'ACTIVE') {
        if (!['PLACED', 'PACKED', 'PART_PACKED', 'PART_SENT', 'SENT', 'OUT_FOR_DELIVERY', 'TROUBLE'].includes(o.state)) return false;
      } else if (filter === 'DELIVERED') {
        if (o.state !== 'DELIVERED') return false;
      } else if (filter === 'CANCELLED') {
        if (o.state !== 'CANCELLED') return false;
      }
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const matchNum = o.orderNumber?.toLowerCase().includes(q);
        const matchItem = o.items?.some(i => i.title?.toLowerCase().includes(q));
        if (!matchNum && !matchItem) return false;
      }
      return true;
    });
  }, [rows, filter, search]);

  if (rows === null) {
    return (
      <div className="account apage">
        <div className="bone" style={{ height: 42, width: 220, borderRadius: 10, margin: '20px 0 16px' }} />
        <div className="bone" style={{ height: 210, borderRadius: 16, margin: '14px 0' }} />
        <div className="bone" style={{ height: 210, borderRadius: 16, margin: '14px 0' }} />
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="account apage">
        <div className="orders-empty-wrap">
          <div className="orders-empty-card">
            <div className="orders-empty-art">
              <EmptyOrders />
            </div>
            <h2>No orders placed yet</h2>
            <p>
              {signedIn(slug)
                ? 'Your order history and live parcel tracking will appear here as soon as you place an order.'
                : 'Orders placed on this device appear here. If you ordered on another device, sign in with your WhatsApp number to sync them.'}
            </p>
            <div className="orders-empty-actions">
              <Link className="go" to={`/${slug}`}>
                Explore collection
              </Link>
              {!signedIn(slug) && shop?.accounts !== false ? (
                <Link className="go quiet" to={`/${slug}/account`}>
                  Sign in to view orders
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const digits = String(shop?.whatsapp || '').replace(/\D/g, '');

  return (
    <div className="account apage orders-page">
      {/* Breadcrumb Navigation */}
      <nav className="acrumb" aria-label="Breadcrumb">
        <Link to={`/${slug}/account`}>Account</Link>
        <span aria-hidden="true">›</span>
        <span>Orders</span>
      </nav>

      {/* Page Header with Stats */}
      <header className="orders-header">
        <div className="orders-title-row">
          <div className="orders-title-group">
            <div className="orders-title-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                <path d="M12 2.8 20.5 7.4v9.2L12 21.2l-8.5-4.6V7.4Z" />
                <path d="M3.8 7.6 12 12l8.2-4.4M12 12v9" />
                <path d="m7.8 5.1 8.4 4.6" />
              </svg>
            </div>
            <div>
              <h1 className="pagetitle">Your Orders</h1>
              <p className="orders-subtitle">
                {rows.length === 1 ? '1 order placed' : `${rows.length} orders placed`} · Follow parcels and manage deliveries
              </p>
            </div>
          </div>

          <Link to={`/${slug}`} className="orders-shop-more">
            Shop collection
            <span aria-hidden="true">→</span>
          </Link>
        </div>

        {/* Filter Navigation Tabs */}
        <div className="orders-filters-row">
          <div className="orders-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'ALL'}
              className={`orders-tab ${filter === 'ALL' ? 'active' : ''}`}
              onClick={() => setFilter('ALL')}
            >
              All orders
              <span className="tab-pill">{counts.all}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'ACTIVE'}
              className={`orders-tab ${filter === 'ACTIVE' ? 'active' : ''}`}
              onClick={() => setFilter('ACTIVE')}
            >
              Active / In Transit
              <span className="tab-pill active-pill">{counts.active}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'DELIVERED'}
              className={`orders-tab ${filter === 'DELIVERED' ? 'active' : ''}`}
              onClick={() => setFilter('DELIVERED')}
            >
              Delivered
              <span className="tab-pill delivered-pill">{counts.delivered}</span>
            </button>
            {counts.cancelled > 0 ? (
              <button
                type="button"
                role="tab"
                aria-selected={filter === 'CANCELLED'}
                className={`orders-tab ${filter === 'CANCELLED' ? 'active' : ''}`}
                onClick={() => setFilter('CANCELLED')}
              >
                Cancelled
                <span className="tab-pill">{counts.cancelled}</span>
              </button>
            ) : null}
          </div>

          {rows.length > 2 && (
            <div className="orders-search">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                placeholder="Search orders or items..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search orders"
              />
              {search && (
                <button type="button" className="clear-search" onClick={() => setSearch('')} aria-label="Clear search">
                  ✕
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Orders List */}
      {filteredOrders.length === 0 ? (
        <div className="orders-none-card">
          <p>No orders matching your selection.</p>
          <button type="button" className="abtn" onClick={() => { setFilter('ALL'); setSearch(''); }}>
            Show all orders
          </button>
        </div>
      ) : (
        <div className="orders-stack">
          {filteredOrders.map(o => {
            const cfg = STATUS_CONFIG[o.state] || STATUS_CONFIG.PLACED;
            const pieces = o.items?.reduce((t, i) => t + (isMetre(i.soldBy) ? 1 : (i.quantity ?? 1)), 0) ?? 1;
            const placedDate = new Date(o.placedAt).toLocaleDateString('en-IN', {
              day: 'numeric',
              month: 'short',
              year: 'numeric'
            });
            const waSupportLink = digits.length >= 10
              ? `https://wa.me/${digits}?text=${encodeURIComponent(`Hi ${shop?.name || ''}, I have a query about my order ${o.orderNumber}`)}`
              : null;

            return (
              <article key={o.token} className="order-box">
                {/* Header: Order ID + Status */}
                <div className="order-box-header">
                  <div className="order-id-group">
                    <span className="order-num-label">Order</span>
                    <strong className="order-num-code">{o.orderNumber}</strong>
                    <button
                      type="button"
                      className="order-copy-btn"
                      onClick={(e) => copyOrderNo(o.orderNumber, e)}
                      title="Copy order number"
                      aria-label="Copy order number"
                    >
                      {copied === o.orderNumber ? (
                        <span className="copied-tag">Copied!</span>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                        </svg>
                      )}
                    </button>
                    <span className="order-dot-sep" aria-hidden="true">·</span>
                    <span className="order-date-text">Placed {placedDate}</span>
                  </div>

                  <div className={`status-pill pill-${cfg.variant}`}>
                    <span className="pill-dot" aria-hidden="true" />
                    <span className="pill-icon" aria-hidden="true">{cfg.icon}</span>
                    <span className="pill-label">{ORDER_WORDS[o.state] ?? cfg.label}</span>
                  </div>
                </div>

                {/* Stepper Progress bar (shown for orders in progress) */}
                {o.state !== 'CANCELLED' && (
                  <div className="order-stepper" aria-label="Delivery progress">
                    <div className="stepper-track">
                      <div
                        className="stepper-progress"
                        style={{
                          width: cfg.step === 1 ? '12%' : cfg.step === 2 ? '42%' : cfg.step === 3 ? '75%' : '100%'
                        }}
                      />
                    </div>
                    <div className="stepper-nodes">
                      {STEP_LABELS.map((label, idx) => {
                        const stepNum = idx + 1;
                        const isDone = cfg.step >= stepNum;
                        const isCurrent = cfg.step === stepNum;
                        return (
                          <div
                            key={label}
                            className={`stepper-node ${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''}`}
                          >
                            <span className="node-marker">
                              {isDone && !isCurrent ? '✓' : stepNum}
                            </span>
                            <span className="node-label">{label}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Items Preview */}
                <div className="order-box-items">
                  <div className="order-thumbs-row">
                    {o.items?.slice(0, 4).map((i, idx) => (
                      <div key={idx} className="order-item-chip">
                        <div className="order-item-shot">
                          {i.imageUrl ? (
                            <img
                              src={sized(i.imageUrl, THUMB)}
                              onError={orWhole(i.imageUrl)}
                              alt={i.title || 'Product'}
                              loading="lazy"
                            />
                          ) : (
                            <div className="order-item-placeholder" />
                          )}
                          {isMetre(i.soldBy) ? <span className="item-qty-badge">{lengthText(i.quantity)}</span> : i.quantity > 1 && <span className="item-qty-badge">{i.quantity}x</span>}
                        </div>
                      </div>
                    ))}
                    {o.items?.length > 4 && (
                      <div className="order-thumbs-more">
                        +{o.items.length - 4} more
                      </div>
                    )}
                  </div>

                  <div className="order-items-desc">
                    <p className="order-items-titles">
                      {o.items?.[0]?.title}
                      {o.items?.length > 1 ? ` and ${o.items.length - 1} other ${o.items.length - 1 === 1 ? 'item' : 'items'}` : ''}
                    </p>
                    <p className="order-items-meta">
                      {pieces} {pieces === 1 ? 'item' : 'items'}
                      {o.items?.[0]?.colour ? ` · ${o.items[0].colour}` : ''}
                    </p>
                  </div>

                  <div className="order-total-badge">
                    <span className="total-label">Total amount</span>
                    <strong className="total-val">{money(o.total)}</strong>
                  </div>
                </div>

                {/* Card Actions Footer */}
                <div className="order-box-actions">
                  <div className="order-action-links">
                    {waSupportLink && (
                      <a
                        href={waSupportLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="order-wa-support"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.13h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.22 8.22 0 0 1-1.26-4.36c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.41a8.18 8.18 0 0 1 2.41 5.83c0 4.54-3.7 8.21-8.24 8.21Z" />
                        </svg>
                        Need help?
                      </a>
                    )}
                  </div>

                  <Link to={`/${slug}/order/${o.token}`} className="order-track-btn">
                    <span>{o.state === 'DELIVERED' ? 'View receipt & order' : 'Track delivery details'}</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12h14" />
                      <path d="m12 5 7 7-7 7" />
                    </svg>
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Device Sync Info Footer */}
      <footer className="orders-footer-info">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <p>
          {signedIn(slug) ? (
            <>All orders associated with your mobile number across any phone or browser.</>
          ) : shop?.accounts !== false ? (
            <>
              Orders shown here are remembered on this device.{' '}
              <Link to={`/${slug}/account`}>Sign in with WhatsApp</Link> to view all your past orders on any phone.
            </>
          ) : (
            <>Orders placed on this device. For other orders, use the receipt link in your WhatsApp confirmation message.</>
          )}
        </p>
      </footer>
    </div>
  );
}
