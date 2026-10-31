import os from 'node:os';

const physicalName = name => /^(en|eth|wlan)\d*/i.test(String(name || ''));

export function buildLanAccess(interfaces = {}, hostname = '', port = 4178) {
  const addresses = Object.entries(interfaces || {})
    .filter(([name]) => physicalName(name))
    .flatMap(([name, list]) => (Array.isArray(list) ? list : [])
      .filter(item => item?.family === 'IPv4' && !item.internal && !String(item.address || '').startsWith('169.254.'))
      .map(item => ({ name, address: item.address })))
    .sort((left, right) => {
      if (left.name === right.name) return 0;
      if (left.name === 'en0') return -1;
      if (right.name === 'en0') return 1;
      return left.name.localeCompare(right.name);
    });
  const primary = addresses[0] || null;
  const localHostName = String(hostname || '').trim();
  const ipUrl = primary ? `http://${primary.address}:${port}` : '';
  const hostnameUrl = localHostName ? `http://${localHostName}:${port}` : '';
  const addressList = addresses.map(item => ({ interface: item.name, address: item.address, url: `http://${item.address}:${port}` }));
  const urls = [...new Set([...addressList.map(item => item.url), hostnameUrl].filter(Boolean))];
  return {
    interface: primary?.name || '',
    ip: primary?.address || '',
    hostname: localHostName,
    ipUrl,
    hostnameUrl,
    addresses: addressList,
    urls,
    primary: urls[0] || '',
    qrUrl: ipUrl || hostnameUrl
  };
}

export function currentLanAccess(port) {
  return buildLanAccess(os.networkInterfaces(), os.hostname(), port);
}
