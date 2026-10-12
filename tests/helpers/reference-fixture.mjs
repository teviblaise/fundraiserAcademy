// Explicit test dependency; production never imports this provider.
export function createReferenceFixture({now=Date.now}={}) {
  const prices={EURUSD:1.085,GBPUSD:1.272,AUDUSD:.66,NZDUSD:.61,USDJPY:150,USDCHF:.89,USDCAD:1.36,EURGBP:.853,EURJPY:162.75,GBPJPY:190.8,BTCUSD:64000,ETHUSD:3200};
  const failures=new Set();const calls=[];
  function valid(symbol){if(!Object.hasOwn(prices,symbol))throw Object.assign(new Error('Unsupported test market.'),{status:400});}
  async function getExecutionQuote(symbol){
    valid(symbol);calls.push(symbol);
    if(failures.has(symbol))throw Object.assign(new Error('Reference provider unavailable.'),{status:503});
    return {symbol,price:prices[symbol],asOf:Math.floor(now()/1000),fetchedAt:now(),source:'Test-only reference provider',sourceUrl:'https://example.com/test-fixture',executable:true};
  }
  async function get(symbol,interval='15m'){
    valid(symbol);if(!['1m','5m','15m','1h','1d'].includes(interval))throw Object.assign(new Error('Unsupported test interval.'),{status:400});
    const quote=await getExecutionQuote(symbol);const crypto=symbol==='BTCUSD'||symbol==='ETHUSD';
    return {...quote,kind:crypto?'ohlc':'daily',interval:crypto?interval:'1d',quoteKind:'intraday',price:quote.price,status:'ok',stale:false,delayed:false,candles:crypto?[{time:quote.asOf,open:quote.price,high:quote.price,low:quote.price,close:quote.price,volume:0}]:[],points:crypto?[]:[{time:quote.asOf,close:quote.price}]};
  }
  return {prices,failures,calls,getExecutionQuote,get,close(){}};
}
