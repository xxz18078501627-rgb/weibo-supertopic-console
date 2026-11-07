// Engage-only DOM support. Never fall back to an unrelated first page button.
export async function markEngagePost(page, id, numeric) {
  return page.evaluate(({ id, numeric }) => {
    document.querySelectorAll('[data-engage-target],[data-engage-toolbar]').forEach(e => { e.removeAttribute('data-engage-target'); e.removeAttribute('data-engage-toolbar'); });
    const matches = a => { try { const p = new URL(a.href, location.href).pathname; return p === '/detail/' + id || p === '/detail/' + numeric || new RegExp('^/\\d+/(' + id + '|' + numeric + ')$').test(p); } catch { return false; } };
    const excluded = e => e.closest('blockquote,[class*="retweet" i],[class*="repost" i],[class*="comment" i]');
    const bars = e => [...e.querySelectorAll('footer,[class*="toolbar" i],[class*="func" i]')].filter(b => !excluded(b) && !b.querySelector('textarea'));
    const cards = [...document.querySelectorAll('article,[role="article"],[data-mid]')];
    for (const a of document.querySelectorAll('a[href]')) if (matches(a) && !excluded(a)) {
      for (let e = a.parentElement, n = 0; e && n < 10; e = e.parentElement, n++) {
        if (bars(e).length) { cards.push(e); break; }
      }
    }
    for (const card of cards) {
      if (excluded(card)) continue;
      const attr = card.getAttribute('data-mid');
      const own = [...card.querySelectorAll('a[href]')].some(a => matches(a) && !excluded(a));
      if (attr !== id && attr !== numeric && !own) continue;
      const ownBars = bars(card).filter(b => { const enclosing = b.closest('article,[role="article"],[data-mid]'); return !enclosing || enclosing === card; });
      if (!ownBars.length) continue;
      card.setAttribute('data-engage-target','true');
      ownBars.forEach(b => b.setAttribute('data-engage-toolbar','true'));
      return true;
    }
    return false;
  }, { id, numeric });
}

export async function engageControl(page, scope, kind) {
  const token = 'engage-' + kind;
  const found = await scope.evaluate((root, {kind, token}) => {
    document.querySelectorAll('[data-engage-control="' + token + '"]').forEach(e => e.removeAttribute('data-engage-control'));
    const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const names = kind === 'repost' ? /retweet|repost|forward|share/ : kind === 'comment' ? /comment/ : /like|attitude/;
    const label = kind === 'repost' ? '转发' : kind === 'comment' ? '评论' : '赞';
    let target = [...root.querySelectorAll('button,[role="button"],[title],[aria-label]')].find(e => visible(e) && [e.title,e.getAttribute('aria-label'),e.textContent?.trim()].includes(label));
    if (!target) {
      const icon = [...root.querySelectorAll('i,svg,use,[class*="icon"], [class*="woo-font"]')].find(e => visible(e) && names.test((e.getAttribute('class') || '') + ' ' + (e.getAttribute('href') || e.getAttribute('xlink:href') || '')));
      if (icon) target = icon.closest('button,[role="button"]') || icon.closest('[class*="woo-box-item"]') || icon.parentElement;
    }
    // Icon-font fallbacks belong only to this exact post toolbar, not comments.
    if (!target && kind !== 'like') {
      const glyph = kind === 'repost' ? '\uE012' : '\uE011';
      const icon = [...root.querySelectorAll('i,span')].find(e => visible(e) && e.textContent?.trim() === glyph);
      if (icon) target = icon.closest('button,[role="button"]') || icon.parentElement;
    }
    if (!target && kind === 'like') target = [...root.querySelectorAll('[class*="like"]')].find(visible);
    if (!target) return false;
    target.setAttribute('data-engage-control', token); return true;
  }, {kind, token});
  return found ? page.locator('[data-engage-control="' + token + '"]') : null;
}

export async function visibleLikeState(button) {
  return button.evaluate(root => {
    if (root.getAttribute('aria-pressed') === 'true' || root.getAttribute('data-liked') === 'true') return true;
    if (/取消赞|已赞/.test([root.getAttribute('title'),root.getAttribute('aria-label')].join(' '))) return true;
    const elements = [root, ...root.querySelectorAll('i,svg,use,span')];
    if (elements.some(e => /(?:^|[\s_-])(liked|active|cur)(?:$|[\s_-])|like-filled|like_fill/.test(String(e.getAttribute('class') || '')))) return true;
    // Weibo's current like button turns orange while hovered. Only the
    // persistent `woo-like-liked` class means it has actually been clicked.
    if (root.matches('.woo-like-main') || root.querySelector('.woo-like-icon, .woo-like-liked')) return false;
    for (const e of elements) {
      const c = getComputedStyle(e).color.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/);
      if (c && +c[1] >= 180 && +c[1] > +c[2] * 1.25 && +c[1] > +c[3] * 1.4) return true;
    }
    // A visible neutral button is the unliked state. It must have a readable
    // icon/text; absence of any target is handled before this function.
    return false;
  });
}

export async function markEngageComments(page, apiRows = []) {
  return page.evaluate(rows => {
    const norm = s => String(s || '').replace(/<[^>]*>/g,'').replace(/\s+/g,'').normalize('NFC');
    const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const likeIn = root => [...root.querySelectorAll('button[title="赞"],button[aria-label="赞"],button[aria-pressed],[class*="woo-font--like"],[class*="like"],button')].find(e => visible(e) && (e.matches('[class*="like"],[aria-pressed]') || e.title === '赞' || e.getAttribute('aria-label') === '赞' || /^(赞|[\d.,万亿+]+)$/.test(e.textContent.trim())));
    document.querySelectorAll('[data-engage-comment],[data-engage-comment-like]').forEach(e => { e.removeAttribute('data-engage-comment'); e.removeAttribute('data-engage-comment-like'); });
    const found = [];
    const add = (root, row, uid) => {
      if (!root || !row.id || found.some(x => x.id === row.id)) return;
      const icon = likeIn(root); if (!icon) return;
      const button = icon.closest('button,[role="button"]') || icon.closest('[class*="woo-box-item"]') || icon.parentElement;
      root.setAttribute('data-engage-comment',row.id); button.setAttribute('data-engage-comment-like',row.id);
      found.push({ id:row.id, text:row.text, authorUid:uid, top:root.getBoundingClientRect().top });
    };
    for (const row of rows) {
      const direct = document.getElementById(row.id) || [...document.querySelectorAll('[data-commentid],[data-comment-id]')].find(e => (e.getAttribute('data-commentid') || e.getAttribute('data-comment-id')) === row.id);
      if (direct) { add(direct,row,row.authorUid); continue; }
      if (!row.authorUid || !row.text) continue;
      for (const a of document.querySelectorAll('a[href]')) {
        let p; try { p = new URL(a.href,location.href).pathname; } catch { continue; }
        if (!['/u/'+row.authorUid,'/'+row.authorUid].includes(p)) continue;
        for (let e=a.parentElement,n=0;e && n<7;e=e.parentElement,n++) {
          if (e.matches('article,[data-engage-target]')) break;
          if (norm(e.innerText).includes(norm(row.text)) && likeIn(e)) { add(e,row,row.authorUid); break; }
        }
      }
    }
    return found.sort((a,b)=>a.top-b.top);
  }, apiRows.map(r=>({id:String(r.idstr || r.id || ''),text:r.text_raw || r.text || '',authorUid:String(r.user?.idstr || r.user?.id || r.authorUid || '')})));
}

// Read the currently rendered comments, not a detached API candidate pool.
// Paths are freshly resolved per step; identity is independent of DOM markers.
export async function readStreamingComments(page, { viewportOnly = true, targetElement = null } = {}) {
  return page.evaluate(({viewportOnly,targetElement}) => {
    const normal = text => String(text || '').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/\s+/g,'').normalize('NFC');
    const visible = e => { const r=e.getBoundingClientRect(),s=getComputedStyle(e); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden'; };
    const path = e => {
      const parts=[];
      for(let n=e;n && n!==document.documentElement;n=n.parentElement) {
        const tag=n.tagName.toLowerCase();
        const siblings=[...n.parentElement.children].filter(x=>x.tagName===n.tagName);
        parts.unshift(tag+':nth-of-type('+(siblings.indexOf(n)+1)+')');
      }
      return 'html > '+parts.join(' > ');
    };
    const owner = a => { try { return new URL(a.href,location.href).pathname.match(/^\/(?:u\/)?(\d+)\/?$/)?.[1] || null; } catch { return null; } };
    const iconSelector='[class*="woo-font--like"], [class*="woo-font--attitude"], button:is([title="赞"],[title="已赞"],[title="取消赞"],[aria-label="赞"],[aria-label="已赞"],[aria-label="取消赞"]), [role="button"]:is([title="赞"],[title="已赞"],[title="取消赞"],[aria-label="赞"],[aria-label="已赞"],[aria-label="取消赞"]),button[aria-pressed], [class*="like"][role="button"], [class*="like"] > svg';
    const result=[], candidates=[], buttons=new Set();
    for(const icon of document.querySelectorAll(iconSelector)) {
      if(!visible(icon) || icon.closest('footer,[class*="toolbar" i],[data-engage-toolbar],blockquote,[class*="retweet" i]')) continue;
      const button=icon.closest('button,[role="button"]') || icon.closest('[class*="woo-box-item"]') || icon.parentElement;
      if(!button || buttons.has(button))continue;
      let root=null,author=null;
      for(let e=button.parentElement,n=0;e && n<10;e=e.parentElement,n++) {
        if(e.matches('article,[role="article"],main,body,[data-engage-target]'))break;
        const links=[...e.querySelectorAll('a[href]')].filter(a=>owner(a));
        if(links.length && normal(e.innerText).length>normal(button.innerText).length+2) {root=e;author=links.find(a=>normal(a.innerText)) || links[0];break;}
      }
      if(!root || !author)continue;
      buttons.add(button);
      candidates.push({root,author,button});
    }
    for(const {root,author,button} of candidates) {
      const parents=candidates.filter(row=>row.root!==root && row.root.contains(root));
      const replyContainer=root.closest('[data-comment-level="2"],[data-comment-level="3"],[data-is-reply="true"],[class*="list2" i],[class*="reply-list" i],[class*="reply_list" i],[class*="reply-item" i],[class*="replyitem" i],[class*="subcomment" i],[class*="commentitem2" i]');
      const isReply=parents.length>0 || Boolean(replyContainer);
      // Strip replies/actions/badges, so another comment's content cannot
      // satisfy keywords and an orange nickname cannot masquerade as a like.
      const body=root.cloneNode(true);
      const cloneOf=node=>{
        const steps=[];for(let e=node;e && e!==root;e=e.parentElement)steps.unshift([...e.parentElement.children].indexOf(e));
        let copy=body;for(const index of steps)copy=copy?.children[index];return copy;
      };
      const ownControl=cloneOf(button);
      const nested=[...new Set(candidates.filter(row=>row.root!==root && root.contains(row.root)).map(row=>row.root))].map(cloneOf);
      const hidden=[...root.querySelectorAll('*')].filter(node=>{const style=getComputedStyle(node);return style.display==='none' || style.visibility==='hidden';}).map(cloneOf);
      for(const node of [...nested,...hidden])node?.remove();
      if(ownControl && ownControl!==body)ownControl.remove();
      const time=(body.textContent || '').match(/(?:\d{2,4}[-/]\d{1,2}[-/]\d{1,2}\s*)?\d{1,2}:\d{2}|刚刚|\d+分钟前/)?.[0] || '';
      body.querySelectorAll('button,[role="button"],a,[class*="woo-font"],svg,[class*="time" i],[class*="date" i],[class*="reply-list" i],[class*="reply_list" i],[class*="list2" i],[class*="vip" i]').forEach(e=>e.remove());
      let text=normal(body.textContent).replace(/^[：:]+/,'');
      const content=[...body.querySelectorAll('[class*="text" i],[class*="content" i]')].filter(e=>normal(e.textContent));
      if(content.length)text=normal(content.sort((a,b)=>normal(b.textContent).length-normal(a.textContent).length)[0].textContent).replace(/^[：:]+/,'');
      // Weibo renders emoji-only replies as <img alt="[表情]">.  textContent is
      // empty for those, but they are still real visible comments and must be
      // eligible for an inner like just like text replies.
      const imageText=[...body.querySelectorAll('img,[role="img"]')]
        .filter(e=>!e.closest('a,button'))
        .map(e=>normal(e.getAttribute('alt')||e.getAttribute('aria-label')||e.getAttribute('title')||''))
        .filter(Boolean);
      if(imageText.length)text=normal([text,...imageText].filter(Boolean).join(' '));
      const authorName=normal(author.innerText);
      if(!text && !authorName)continue;
      const closestAttrs=root.closest('[data-commentid],[data-comment-id]');
      const attrs=parents.some(row=>closestAttrs?.contains(row.root)) ? null : closestAttrs;
      const permalink=[...root.querySelectorAll('a[href]')].filter(a=>!candidates.some(row=>row.root!==root && root.contains(row.root) && row.root.contains(a))).map(a=>{try{const u=new URL(a.href,location.href);return u.searchParams.get('comment_id') || u.searchParams.get('cid');}catch{return null;}}).find(Boolean);
      const realId=attrs?.getAttribute('data-commentid') || attrs?.getAttribute('data-comment-id') || permalink;
      // The fallback identity must include the visible nickname.  Weibo omits
      // durable comment ids on inline replies, and one parent commonly shows
      // several replies by different users at the same timestamp.
      const key=realId ? 'cid:'+realId : 'dom:'+JSON.stringify([owner(author),authorName,text,time]);
      const id=realId || key;
      const r=button.getBoundingClientRect();
      const inView=r.bottom>85 && r.top<innerHeight && r.right>0 && r.left<innerWidth;
      const classes=[button,...button.querySelectorAll('i,svg,span,use')];
      let liked=button.getAttribute('aria-pressed')==='true' || button.getAttribute('data-liked')==='true' || /已赞|取消赞/.test([button.getAttribute('title'),button.getAttribute('aria-label')].join(' '));
      const managedLike=button.matches('.woo-like-main') || Boolean(button.querySelector('.woo-like-icon, .woo-like-liked'));
      for(const e of classes) {
        if(/(?:^|[\s_-])(liked|active|cur)(?:$|[\s_-])|like-filled|like_fill/.test(e.getAttribute('class') || ''))liked=true;
        if(managedLike)continue;
        const color=getComputedStyle(e).color.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/);
        if(color && +color[1]>=180 && +color[1]>+color[2]*1.25 && +color[1]>+color[3]*1.4)liked=true;
      }
      result.push({id,key,text,authorUid:owner(author),authorName,liked,isReply,inView,pinned:Boolean(targetElement && button===targetElement),selector:path(button),top:r.top,left:r.left});
    }
    // Ambiguous duplicates are deliberately not clicked. DOM position is not
    // a durable comment identity, especially during virtual-list replacement.
    const counts=new Map();for(const row of result)counts.set(row.key,(counts.get(row.key)||0)+1);
    // Deduplicate over the same rendered set for scanning AND re-resolution;
    // viewport filtering must not turn a duplicate into a seemingly unique row.
    // When re-checking a pinned button, keep that exact node even if its
    // derived key is duplicated or drifted; the pinned handle is the source of
    // truth for the one permitted click.
    return result.filter(row=>(row.pinned || counts.get(row.key)===1) && (!viewportOnly || row.inView)).sort((a,b)=>a.top-b.top || a.left-b.left);
  },{viewportOnly,targetElement});
}

export async function scrollStreamingComments(page) {
  return page.evaluate(() => {
    const editor=document.querySelector('textarea[placeholder*="评论"]');
    let root=editor?.parentElement;
    while(root && root!==document.body) {
      const style=getComputedStyle(root);
      if(/auto|scroll/.test(style.overflowY) && root.scrollHeight>root.clientHeight+10)break;
      root=root.parentElement;
    }
    root=root && root!==document.body ? root : document.scrollingElement;
    const before=root.scrollTop;
    root.scrollBy(0,Math.max(160,Math.round((root===document.scrollingElement?innerHeight:root.clientHeight)*.8)));
    return {moved:root.scrollTop!==before,position:root.scrollTop,height:root.scrollHeight,bottom:root.scrollTop+root.clientHeight>=root.scrollHeight-5};
  });
}

export async function waitForStreamingCommentSettle(page, { maxMs = 500, quietMs = 120, minMs = 120 } = {}) {
  return page.evaluate(async ({ maxMs, quietMs, minMs }) => {
    const start = performance.now();
    let lastMutation = start;
    const observer = new MutationObserver(() => { lastMutation = performance.now(); });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'aria-label', 'title'] });
    try {
      while (performance.now() - start < maxMs) {
        await new Promise(resolve => setTimeout(resolve, 40));
        const elapsed = performance.now() - start;
        if (elapsed >= minMs && performance.now() - lastMutation >= quietMs) break;
      }
    } finally { observer.disconnect(); }
    return Math.round(performance.now() - start);
  }, { maxMs, quietMs, minMs });
}
