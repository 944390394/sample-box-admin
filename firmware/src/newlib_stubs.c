/* newlib 的 __libc_init_array 会调用这两个符号。不用 C++ 静态构造，留空即可。 */
void _init(void)
{
}

void _fini(void)
{
}
