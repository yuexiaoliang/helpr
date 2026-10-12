// 独立调用进程；父进程只转发 IPC，不判定或序列化业务资格。
process.on('message',message=>{
  if(message.start)process.send({command:message.command});
  else if(message.result){process.send({finished:message.result},()=>process.exit(0));}
});
