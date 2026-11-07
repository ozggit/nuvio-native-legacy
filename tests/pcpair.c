#include "pcpair.h"
#include "rede.h"
#include "js.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <ifaddrs.h>
#include <arpa/inet.h>

static pthread_mutex_t lock=PTHREAD_MUTEX_INITIALIZER;
static int finish, valid, calls;
static struct sockaddr_in address;
static const char *ticket="0123456789abcdef0123456789abcdef";
int rede_pedir(const RedePedido *p,RedeResposta *r) {
  assert(!strcmp(p->metodo,"POST"));assert(!p->seguir);assert(p->max_bytes==1024);
  assert(!strstr(p->url,"1234")&&!strchr(p->url,'#'));
  char code[8], nonce[40];assert(js_texto_raiz(p->corpo,"code",code,sizeof code));
  assert(js_texto_raiz(p->corpo,"ticket",nonce,sizeof nonce));assert(!strcmp(nonce,ticket));
  pthread_mutex_lock(&lock);calls++;pthread_mutex_unlock(&lock);
  if(!strcmp(code,"2222"))usleep(250000);
  memset(r,0,sizeof *r);r->status=!strcmp(code,"0000")?401:200;
  r->corpo=strdup(r->status==200?"{\"protocol\":1,\"token\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}":"{}");
  r->n_corpo=strlen(r->corpo);return 1;
}
void rede_resposta_limpar(RedeResposta *r) {free(r->corpo);memset(r,0,sizeof *r);}
static void *broadcast(void *unused) {
  (void)unused;int fd=socket(AF_INET,SOCK_DGRAM,0);assert(fd>=0);
  struct sockaddr_in from=address;from.sin_port=0;assert(!bind(fd,(void *)&from,sizeof from));
  for(;;){pthread_mutex_lock(&lock);int stop=finish,good=valid;pthread_mutex_unlock(&lock);if(stop)break;
    const char *msg=good?"NUVIO-PC-PAIR/1 8787 0123456789abcdef0123456789abcdef":"NUVIO-PC-PAIR/1 8787 bad";
    assert(sendto(fd,msg,strlen(msg),0,(void *)&address,sizeof address)>0);usleep(20000);
  }close(fd);return NULL;
}
static void waitResult(char *pair,char *error) {
  for(int n=0;n<300;n++){if(pcpair_receber(pair,192,error,192))return;usleep(10000);}
  assert(!"Pairing worker timed out");
}
int main(void) {
  struct ifaddrs *interfaces;assert(!getifaddrs(&interfaces));
  for(struct ifaddrs *i=interfaces;i;i=i->ifa_next) {
    if(i->ifa_addr&&i->ifa_addr->sa_family==AF_INET){
      struct sockaddr_in *a=(void *)i->ifa_addr;unsigned ip=ntohl(a->sin_addr.s_addr),first=ip>>24,second=(ip>>16)&255;
      if(first==10||(first==192&&second==168)||(first==172&&second>=16&&second<=31)){address=*a;break;}
    }
  }
  freeifaddrs(interfaces);assert(address.sin_family==AF_INET);address.sin_port=htons(8789);
  pthread_t sender;assert(!pthread_create(&sender,NULL,broadcast,NULL));
  assert(!pcpair_iniciar("123"));assert(!pcpair_iniciar("12345"));assert(!pcpair_iniciar("abcd"));
  assert(pcpair_iniciar("1234"));usleep(100000);
  pthread_mutex_lock(&lock);assert(!calls);valid=1;pthread_mutex_unlock(&lock);
  char pair[192],error[192];waitResult(pair,error);assert(!error[0]);assert(strstr(pair,"#aaaaaaaa"));assert(!pcpair_pendente());
  assert(pcpair_iniciar("0000"));waitResult(pair,error);assert(!pair[0]);assert(strstr(error,"did not match"));
  assert(pcpair_iniciar("2222"));usleep(60000);pcpair_cancelar();usleep(300000);
  assert(!pcpair_receber(pair,sizeof pair,error,sizeof error));assert(!pcpair_pendente());
  assert(pcpair_iniciar("1234"));waitResult(pair,error);assert(!error[0]);assert(pair[0]);
  pcpair_cancelar();pthread_mutex_lock(&lock);finish=1;pthread_mutex_unlock(&lock);pthread_join(sender,NULL);
  puts("PASS: four-digit pairing, LAN discovery, malformed beacons, incorrect code and cancellation");return 0;
}
