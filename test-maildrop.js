async function test() {
  console.log('=== Get inbox ===');
  const res = await fetch('https://api.maildrop.cc/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: '{ inbox(mailbox: "hello") { id headerfrom subject date } }'
    })
  });
  const data = await res.json();
  const msgs = data.data?.inbox || [];
  console.log('Messages:', msgs.length);

  if (msgs.length > 0) {
    console.log('\n=== Read message ===');
    const msgId = msgs[0].id;
    const msgRes = await fetch('https://api.maildrop.cc/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '{ message(mailbox: "hello", id: "' + msgId + '") { id headerfrom subject date html } }'
      })
    });
    const msgData = await msgRes.json();
    const msg = msgData.data?.message;
    if (msg) {
      console.log('From:', msg.headerfrom);
      console.log('Subject:', msg.subject);
      console.log('HTML length:', msg.html?.length || 0);
    }
  }

  console.log('\n=== Schema ===');
  const schemaRes = await fetch('https://api.maildrop.cc/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: '{ __type(name: "Message") { fields { name type { name } } } }'
    })
  });
  const schemaData = await schemaRes.json();
  console.log('Fields:', JSON.stringify(schemaData.data?.__type?.fields?.map(f => f.name)));
}
test();
